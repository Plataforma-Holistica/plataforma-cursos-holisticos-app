import { describe, expect, it } from "vitest";

import { givenCodeOutcome } from "./fresh-code";

// «Tu código», compartido por las secciones que cambian algo con un código reciente. Cada
// una le dice cuál es su página: dado el código, se vuelve ahí, nunca a la de otra sección
// (quien solo tiene Contenido vería PA-88 en la del equipo).

describe.each(["/admin/equipo", "/admin/practicas"])("en %s", (page) => {
  const toPage = { kind: "leave", to: page, notice: null };

  it("verificado: se redirige a su página, y no se vuelve a pintar", () => {
    expect(givenCodeOutcome({ kind: "verified" }, page)).toEqual(toPage);
  });

  it("a quien la guarda no dejó, a su página, donde decide ella", () => {
    expect(givenCodeOutcome({ kind: "refused" }, page)).toEqual(toPage);
  });

  it("equivocado: se dice en el campo", () => {
    expect(givenCodeOutcome({ kind: "wrong_code" }, page)).toEqual({ kind: "failed", reason: "wrong_code" });
  });

  it("frenado: Auth ya cerró todo, y sale a entrar con su aviso", () => {
    expect(givenCodeOutcome({ kind: "throttled" }, page)).toEqual({ kind: "leave", to: "/entrar", notice: "second_factor_throttled" });
  });

  it("correcto y aun así ningún cambio pasaría: se dice que no lo arregla reintentar", () => {
    expect(givenCodeOutcome({ kind: "not_available" }, page)).toEqual({ kind: "failed", reason: "not_available" });
  });

  it("no se supo quién pide: no se pinta como hecho", () => {
    expect(givenCodeOutcome({ kind: "unavailable" }, page)).toEqual({ kind: "failed", reason: "unavailable" });
  });
});
