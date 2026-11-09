import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { changedFiles, touchesCode } from "../../scripts/ci-cambios.mjs";

// La integración continua gasta menos corridas (decisión de Sergio del 2026-11-09): corre en cada solicitud y en la cola de fusión, ya
// no al entrar a main; en un borrador se salta el extremo a extremo del equipo; y un cambio que solo toca documentos no levanta nada.
// Lo que no debe perderse: que nada entre a main sin verificar. Por eso es un solo trabajo, que siempre contesta (una corrida
// cancelada nunca se ve como pasada), la cola siempre verifica entero, y si la detección falla todo corre.

const ci = readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("\r", "");
const COND = "steps.mira.outputs.codigo != 'false'";

/** Los pasos del trabajo, con su nombre y su `if`, en orden. */
function steps(): { name: string; condition: string | null }[] {
  const lines = ci.split("\n");
  const found: { name: string; condition: string | null }[] = [];
  lines.forEach((line, index) => {
    const named = /^ {6}- (?:name: (.+)|id: (.+)|uses: (.+))$/.exec(line);
    if (!named) return;
    let name = named[1] ?? named[2] ?? named[3] ?? "";
    let condition: string | null = null;
    for (let next = index + 1; next < lines.length && /^ {8}\S/.test(lines[next]!); next += 1) {
      const nameLine = /^ {8}name: (.+)$/.exec(lines[next]!);
      if (nameLine) name = nameLine[1]!;
      const ifLine = /^ {8}if: (.+)$/.exec(lines[next]!);
      if (ifLine) condition = ifLine[1]!;
    }
    found.push({ name, condition });
  });
  return found;
}

describe("cuándo corre la integración continua", () => {
  it("en cada solicitud y en la cola de fusión, y ya no al entrar a main", () => {
    expect(ci).toMatch(/^on:\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review\]\n {2}merge_group:\n/m);
    expect(ci).not.toMatch(/^ {2}push:/m);
  });

  it("un solo trabajo, verificar, sin condición: siempre contesta", () => {
    const jobs = ci.slice(ci.indexOf("\njobs:\n"));
    expect(jobs.match(/^ {2}[a-z_-]+:$/gm)).toEqual(["  verificar:"]);
    expect(jobs).not.toMatch(/^ {4}(if|needs):/m);
  });

  it("el paso que mira: en la cola siempre entero, y si falla, todo corre", () => {
    expect(ci).toContain(
      '      - id: mira\n        name: Qué cambió\n        continue-on-error: true\n        env:\n          EVENT: ${{ github.event_name }}\n' +
        '        run: |\n          if [ "$EVENT" = "merge_group" ]; then\n            echo "codigo=true" >> "$GITHUB_OUTPUT"\n' +
        '          else\n            node scripts/ci-cambios.mjs HEAD^1 HEAD >> "$GITHUB_OUTPUT"\n          fi\n',
    );
  });

  it("después de mirar, cada paso se salta con solo documentos, salvo instalar y el escaneo de secretos", () => {
    const all = steps();
    const after = all.slice(all.findIndex((step) => step.name === "Qué cambió") + 1);
    expect(after.length).toBeGreaterThan(15);
    for (const step of after) {
      if (step.name === "Instalar dependencias" || step.name === "Escaneo de secretos") expect(step.condition, step.name).toBeNull();
      else expect(step.condition, step.name).toContain(`\${{ ${COND}`);
    }
  });

  it("el extremo a extremo del equipo se salta además en una solicitud en borrador, y solo él", () => {
    const team = steps().find((step) => step.name === "Pruebas de extremo a extremo del equipo");
    expect(team?.condition).toBe(`\${{ ${COND} && (github.event_name == 'merge_group' || !github.event.pull_request.draft) }}`);
    expect(ci.match(/pull_request\.draft/g)).toHaveLength(1);
  });
});

describe("qué cuenta como código", () => {
  it.each([
    [["CLAUDE.md"], false],
    [["README.md", "docs/notas.md"], false],
    [["CLAUDE.md", "src/app/page.tsx"], true],
    [["supabase/local/legal-drafts/terms.md"], true],
    [["src/messages/notas.md"], true],
    [["tests/fixtures/x.md"], true],
    [["scripts/LEEME.md"], true],
    [[".github/workflows/ci.yml"], true],
    [["package.json"], true],
    [[], true],
  ])("%j: %s", (files, expected) => {
    expect(touchesCode(files)).toBe(expected);
  });

  it("un renombre de código a Markdown cuenta con su nombre de antes: borra código", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-cambios-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=ci@prueba.test", "-c", "user.name=ci", ...args], { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "x.ts"), "export const x = 1;\n".repeat(20));
      git("add", "-A");
      git("commit", "-q", "-m", "uno");
      git("mv", "src/x.ts", "notas.md");
      git("commit", "-q", "-m", "dos");
      const files = changedFiles("HEAD~1", "HEAD", dir);
      expect(files.sort()).toEqual(["notas.md", "src/x.ts"]);
      expect(touchesCode(files)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
