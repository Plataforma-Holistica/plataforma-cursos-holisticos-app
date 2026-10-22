import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// El turno de la base local (ola 0), contra dos copias de un repositorio temporal: la principal y
// un `git worktree`, como `plataforma/` y `plataforma-b/`. La comparación con la base de verdad
// (`exigir --base`) se revisa a mano: aquí no hay base.

const SCRIPT = resolve("scripts/db-turno.mjs");
let root: string;
let a: string;
let b: string;
let lock: string;

/** El entorno sin las marcas de la integración continua: con ellas, el guion no hace nada. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // En Windows los nombres no distinguen mayúsculas: se quitan en cualquier forma.
  const drop = new Set(["ci", "vercel", "vercel_env", "database_url_direct", "npm_lifecycle_event"]);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !drop.has(key.toLowerCase())));
  return { ...clean, NODE_ENV: process.env.NODE_ENV, npm_lifecycle_event: "test:db", ...extra };
}

function run(copy: string, ...args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: copy, encoding: "utf8", env: env() });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=prueba", "-c", "user.email=prueba@prueba.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** Un turno escrito a mano: de qué copia, con qué proceso y hace cuántos minutos se usó. */
function turnOf(copy: string, pid: number, minutesAgo: number): void {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  writeFileSync(lock, JSON.stringify({ turno: { copia: copy, desde: at, ultimoUso: at, procesos: [{ pid, comando: "dev", desde: at }] } }));
}

/** El número de un proceso que ya terminó. */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turno-"));
  a = join(root, "a");
  b = join(root, "b");
  execFileSync("git", ["init", "-q", "-b", "main", a]);
  writeFileSync(join(a, "leeme.txt"), "x");
  git(a, "add", "-A");
  git(a, "commit", "-q", "-m", "base");
  git(a, "worktree", "add", "-q", "--detach", b);
  lock = join(a, ".git", "plataforma-turno.json");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("el turno de la base", () => {
  it("libre, una copia lo toma y lo dice", () => {
    expect(run(a, "estado").out).toContain("libre");
    expect(run(a, "exigir")).toMatchObject({ status: 0 });
    expect(run(a, "estado").out).toContain("de esta copia");
    expect(run(b, "estado").out).toContain("de la otra copia");
    expect(JSON.parse(readFileSync(lock, "utf8")).turno.procesos[0].comando).toBe("test:db");
  });

  it("la otra copia no lo toma mientras es reciente, aunque nada siga vivo", () => {
    turnOf(a, deadPid(), 5);
    const result = run(b, "exigir");
    expect(result.status).toBe(1);
    expect(result.out).toContain("es de la otra copia");
  });

  it("ni vencido por tiempo, si un proceso suyo sigue vivo (un pnpm dev)", () => {
    turnOf(a, process.pid, 120);
    expect(run(b, "exigir")).toMatchObject({ status: 1, out: expect.stringContaining("corriendo: dev") });
  });

  it("vencido, sin procesos vivos y sin uso en 30 minutos, la otra copia lo toma", () => {
    turnOf(a, deadPid(), 31);
    expect(run(b, "exigir")).toMatchObject({ status: 0 });
    expect(run(b, "estado").out).toContain("de esta copia");
  });

  it("un proceso anotado hace más de doce horas ya no cuenta como vivo", () => {
    turnOf(a, process.pid, 13 * 60);
    expect(run(b, "exigir")).toMatchObject({ status: 0 });
  });

  it("la misma copia lo vuelve a pedir sin problema", () => {
    expect(run(a, "exigir")).toMatchObject({ status: 0 });
    expect(run(a, "exigir")).toMatchObject({ status: 0 });
  });

  it("soltar: la dueña lo suelta; la otra solo con --forzar y si nada suyo sigue vivo", () => {
    turnOf(a, process.pid, 1);
    expect(run(b, "soltar")).toMatchObject({ status: 1 });
    expect(run(b, "soltar", "--forzar")).toMatchObject({ status: 1, out: expect.stringContaining("procesos vivos") });
    turnOf(a, deadPid(), 1);
    expect(run(b, "soltar")).toMatchObject({ status: 1, out: expect.stringContaining("es de la otra copia") });
    expect(run(b, "soltar", "--forzar")).toMatchObject({ status: 0 });
    expect(run(a, "estado").out).toContain("libre");
    expect(run(a, "exigir")).toMatchObject({ status: 0 });
    expect(run(a, "soltar")).toMatchObject({ status: 0 });
    expect(run(b, "exigir")).toMatchObject({ status: 0 });
  });

  it("un candado que no se lee se niega, y soltar --forzar lo arregla", () => {
    writeFileSync(lock, "{ no es json");
    expect(run(a, "exigir")).toMatchObject({ status: 1, out: expect.stringContaining("no se pudo leer") });
    expect(run(a, "soltar")).toMatchObject({ status: 1, out: expect.stringContaining("no se pudo leer") });
    expect(run(a, "soltar", "--forzar")).toMatchObject({ status: 0 });
    expect(run(a, "exigir")).toMatchObject({ status: 0 });
  });

  it("en la integración continua no hace nada, ni crea el candado", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "exigir", "--base"], { cwd: a, encoding: "utf8", env: env({ CI: "true" }) });
    expect(result.status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("con --base y sin con qué comparar la base se niega; con --base=aviso solo avisa", () => {
    expect(run(a, "exigir", "--base")).toMatchObject({ status: 1, out: expect.stringContaining("DATABASE_URL_DIRECT") });
    expect(run(a, "exigir", "--base=aviso")).toMatchObject({ status: 0, out: expect.stringContaining("aviso") });
  });

  it("un argumento que no conoce se niega", () => {
    expect(run(a, "exigir", "--bases")).toMatchObject({ status: 1 });
    expect(run(a, "otro")).toMatchObject({ status: 1 });
  });

  it("dos copias a la vez: el turno queda de una sola", async () => {
    const attempt = (copy: string) =>
      new Promise<{ copy: string; status: number | null }>((done) => {
        const child = spawn(process.execPath, [SCRIPT, "exigir"], { cwd: copy, env: env(), stdio: "ignore" });
        child.on("exit", (status) => done({ copy, status }));
      });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(i % 2 === 0 ? a : b)));
    const winners = new Set(results.filter((r) => r.status === 0).map((r) => r.copy));
    expect(winners.size).toBe(1);
    const owner = JSON.parse(readFileSync(lock, "utf8")).turno.copia.toLowerCase();
    expect(owner).toBe(resolve([...winners][0]!).toLowerCase());
  });
});
