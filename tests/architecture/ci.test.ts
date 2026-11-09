import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { touchesCode } from "../../scripts/ci-cambios.mjs";

// La integración continua gasta menos corridas (decisión de Sergio del 2026-11-09): corre en cada solicitud y en la cola de fusión, ya
// no al entrar a main; en un borrador se salta el extremo a extremo del equipo; y un cambio que solo toca documentos no levanta nada.
// Lo que no debe perderse: que nada se salte la verificación por una falla, y que lo que entra a main pase entero por la cola.

const ci = readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("\r", "");

describe("cuándo corre la integración continua", () => {
  it("en cada solicitud y en la cola de fusión, y ya no al entrar a main", () => {
    expect(ci).toMatch(/^on:\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review\]\n {2}merge_group:\n/m);
    expect(ci).not.toMatch(/^ {2}push:/m);
  });

  it("verificar se salta solo si «cambios» contestó que no hay código; si falló, corre entero", () => {
    expect(ci).toContain("    needs: cambios\n    if: ${{ !cancelled() && !(needs.cambios.result == 'success' && needs.cambios.outputs.codigo == 'false') }}\n");
  });

  it("el extremo a extremo del equipo se salta solo en una solicitud en borrador", () => {
    expect(ci).toContain(
      "      - name: Pruebas de extremo a extremo del equipo\n        if: ${{ github.event_name == 'merge_group' || !github.event.pull_request.draft }}\n",
    );
    // Ningún otro paso se salta por el borrador.
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
});
