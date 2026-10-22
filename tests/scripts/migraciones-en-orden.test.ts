import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// El guion que comprueba el orden de las migraciones (ola 0), contra un repositorio de git de
// verdad, temporal: una base con dos migraciones y una rama que agrega, edita o borra.

const SCRIPT = resolve("scripts/migraciones-en-orden.mjs");
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=prueba", "-c", "user.email=prueba@prueba.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function migration(name: string, body = "select 1;\n"): void {
  writeFileSync(join(repo, "supabase", "migrations", name), body);
}

function commit(message: string): void {
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

function check(base = "main", head = "rama"): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, [SCRIPT, base, head], { cwd: repo, encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "migraciones-"));
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
  migration("20261021200000_uno.sql");
  migration("20261022010543_dos.sql");
  commit("base");
  git("checkout", "-q", "-b", "rama");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("migraciones en orden", () => {
  it("una migración posterior a todas las de la base pasa", () => {
    migration("20261022031952_tres.sql");
    commit("tres");
    expect(check()).toMatchObject({ status: 0 });
  });

  it("sin migraciones nuevas pasa", () => {
    writeFileSync(join(repo, "otro.txt"), "x");
    commit("otro");
    expect(check()).toMatchObject({ status: 0 });
  });

  it("una anterior a la última de la base falla, y sugiere el nombre", () => {
    migration("20261022000000_tarde.sql");
    commit("tarde");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.out).toContain("20261022000000_tarde.sql: va antes de la última");
    expect(result.out).toMatch(/Renómbrala: \d{14}_tarde\.sql/);
  });

  it("igual a la última de la base falla: repite la versión", () => {
    migration("20261022010543_igual.sql");
    commit("igual");
    expect(check()).toMatchObject({ status: 1, out: expect.stringContaining("repite la versión") });
  });

  it("dos nuevas con la misma versión fallan", () => {
    migration("20261022031952_a.sql");
    migration("20261022031952_b.sql");
    commit("dos");
    expect(check()).toMatchObject({ status: 1, out: expect.stringContaining("repite la versión") });
  });

  it("un nombre sin la forma falla", () => {
    migration("20261022031952_Con-Mayusculas.sql");
    commit("nombre");
    expect(check()).toMatchObject({ status: 1, out: expect.stringContaining("no tiene la forma") });
  });

  it("editar una que ya estaba en la base falla", () => {
    migration("20261022010543_dos.sql", "select 2;\n");
    commit("edita");
    expect(check()).toMatchObject({ status: 1, out: expect.stringContaining("20261022010543_dos.sql: ya estaba") });
  });

  it("borrar una que ya estaba en la base falla", () => {
    unlinkSync(join(repo, "supabase", "migrations", "20261021200000_uno.sql"));
    commit("borra");
    expect(check()).toMatchObject({ status: 1, out: expect.stringContaining("20261021200000_uno.sql: ya estaba") });
  });

  it("lo que la base agregó después de separarse no cuenta como borrado, y la nueva va después de eso", () => {
    migration("20261022031952_tres.sql");
    commit("tres");
    git("checkout", "-q", "main");
    migration("20261022040000_otra_rama.sql");
    commit("la otra rama entró antes");
    git("checkout", "-q", "rama");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.out).toContain("20261022031952_tres.sql: va antes de la última de main (20261022040000_otra_rama.sql)");
    expect(result.out).not.toContain("otra_rama.sql: ya estaba");
  });

  it("en la integración continua, contra la fusión de prueba (HEAD^1 HEAD)", () => {
    migration("20261022031952_tres.sql");
    commit("tres");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "rama", "-m", "fusión");
    expect(check("HEAD^1", "HEAD")).toMatchObject({ status: 0 });
  });

  it("sin dos referencias, no corre", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "main"], { cwd: repo, encoding: "utf8" });
    expect(run.status).toBe(2);
  });
});
