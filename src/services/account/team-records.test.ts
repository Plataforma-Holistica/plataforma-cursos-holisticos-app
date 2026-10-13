import { describe, expect, it } from "vitest";

import { ACCEPT_ANSWERS } from "./team";
import { acceptAnswerOf, standingOf, type StandingRow } from "./team-records";

// Lo que la base contesta se entiende o no se entiende: aquí no se adivina. Las consultas
// contra la base de verdad se prueban en `tests/integration/34-equipo-servicios.test.ts`.

const FACTOR = "fa000000-0000-4000-8000-0000000000b0";
const row = (over: Partial<StandingRow> & { state: string }): StandingRow => ({ factor: null, kind: null, capabilities: [], ...over });

describe("el estado del equipo, como lo contesta la base", () => {
  it("quien no es del equipo ni tiene invitación", () => {
    expect(standingOf(row({ state: "none" }))).toEqual({ state: "none" });
  });

  it("quien conserva capacidades y no tiene con qué volver", () => {
    expect(standingOf(row({ state: "unbound" }))).toEqual({ state: "unbound" });
  });

  it("quien es del equipo trae su factor atado y sus capacidades activas", () => {
    expect(standingOf(row({ state: "member", factor: FACTOR, capabilities: ["config", "support"] }))).toEqual({
      state: "member",
      factor: FACTOR,
      capabilities: ["config", "support"],
    });
  });

  it("a quien le falta el código se le dice con qué factor", () => {
    expect(standingOf(row({ state: "needs_code", factor: FACTOR }))).toEqual({ state: "needs_code", factor: FACTOR });
  });

  it.each(["grant", "rebind"] as const)("una invitación %s con el buzón probado dice qué daría", (kind) => {
    const capabilities = kind === "grant" ? ["support"] : [];
    expect(standingOf(row({ state: "invited", kind, capabilities }))).toEqual({ state: "invited", kind, capabilities });
  });

  it("sin el buzón probado no dice qué daría, aunque la fila lo trajera", () => {
    expect(standingOf(row({ state: "invited_unproven", kind: "grant", capabilities: ["config"] }))).toEqual({
      state: "invited_unproven",
      kind: "grant",
    });
  });

  it("lo que sobra en la fila no pasa al estado", () => {
    expect(standingOf(row({ state: "none", factor: FACTOR, kind: "grant", capabilities: ["config"] }))).toEqual({ state: "none" });
    expect(standingOf(row({ state: "needs_code", factor: FACTOR, kind: "grant", capabilities: ["config"] }))).toEqual({
      state: "needs_code",
      factor: FACTOR,
    });
  });

  it.each<[string, StandingRow]>([
    ["un estado que no se conoce", row({ state: "admin" })],
    ["un estado vacío", row({ state: "" })],
    ["un estado con mayúsculas", row({ state: "Member", factor: FACTOR, capabilities: ["config"] })],
    ["del equipo, sin factor", row({ state: "member", capabilities: ["config"] })],
    ["del equipo, con algo que no es un factor", row({ state: "member", factor: "el-de-siempre", capabilities: ["config"] })],
    ["del equipo, sin ninguna capacidad", row({ state: "member", factor: FACTOR })],
    ["falta el código, sin decir de cuál factor", row({ state: "needs_code" })],
    ["falta el código, con un factor en mayúsculas", row({ state: "needs_code", factor: FACTOR.toUpperCase() })],
    ["invitada, sin tipo", row({ state: "invited", capabilities: ["config"] })],
    ["invitada, de un tipo que no existe", row({ state: "invited", kind: "owner", capabilities: ["config"] })],
    ["invitada sin probar, sin tipo", row({ state: "invited_unproven" })],
  ])("no se adivina: %s", (_what, bad) => {
    expect(() => standingOf(bad)).toThrow("no se entiende");
  });
});

describe("lo que contesta aceptar una invitación", () => {
  it.each(ACCEPT_ANSWERS)("%s es una de sus respuestas", (answer) => {
    expect(acceptAnswerOf(answer)).toBe(answer);
  });

  it("son nueve, las que escribe la función de la base", () => {
    expect([...ACCEPT_ANSWERS].sort()).toEqual([
      "accepted",
      "already_bound",
      "ineligible",
      "inviter_lost_config",
      "needs_code",
      "needs_handoff",
      "needs_mailbox_proof",
      "no_invitation",
      "unavailable",
    ]);
  });

  it.each(["", "Accepted", "accepted ", "ok", "forbidden", "needs_fresh_code"])("%j no lo es, y no se toma por ninguna", (answer) => {
    expect(() => acceptAnswerOf(answer)).toThrow("no contesta");
  });
});
