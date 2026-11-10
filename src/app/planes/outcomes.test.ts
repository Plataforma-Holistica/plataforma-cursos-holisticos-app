import { describe, expect, it } from "vitest";

import { confirmingHref, monthlyEquivalent, plansAnswerOf, plansHref, priceText, readPlansForm, readPlansQuery } from "./outcomes";

const DOC = "11111111-2222-4333-8444-555555555555";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

const FULL: [string, string][] = [
  ["plan", "monthly"],
  ["monto", "34900"],
  ["texto", DOC],
  ["volver", "/cursos/uno"],
  ["acepto", "on"],
];

describe("PA-04, lo que llega del formulario", () => {
  it("lee el plan, el monto y el texto vistos, a dónde volver y la casilla", () => {
    expect(readPlansForm(form(FULL))).toEqual({ plan: "monthly", amount: 34900, document: DOC, returnTo: "/cursos/uno", accepted: true });
  });

  it("lo que no es un formulario no se lee", () => {
    expect(readPlansForm({ plan: "monthly" })).toBeNull();
    expect(readPlansForm(null)).toBeNull();
  });

  it.each([
    ["un plan que no existe", "plan", "weekly"],
    ["un plan vacío", "plan", ""],
  ])("%s no es un plan", (_, name, value) => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === name ? [k, value] : [k, v]))))?.plan).toBeNull();
  });

  it.each(["0", "-1", "34.90", "1e5", "034900", "", "1234567890123"])("el monto %j no es un monto", (amount) => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === "monto" ? [k, amount] : [k, v]))))?.amount).toBeNull();
  });

  it.each(["", "no-es-uuid", "AAAAAAAA-2222-4333-8444-555555555555", `${DOC}x`])("el texto %j no es un texto", (document) => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === "texto" ? [k, document] : [k, v]))))?.document).toBeNull();
  });

  it("un campo repetido no vale: ni el plan ni la casilla", () => {
    expect(readPlansForm(form([...FULL, ["plan", "annual"]]))?.plan).toBeNull();
    expect(readPlansForm(form([...FULL, ["acepto", "on"]]))?.accepted).toBe(false);
  });

  it("la casilla vale solo con su valor", () => {
    expect(readPlansForm(form(FULL.map(([k, v]) => (k === "acepto" ? [k, "true"] : [k, v]))))?.accepted).toBe(false);
    expect(readPlansForm(form(FULL.filter(([k]) => k !== "acepto")))?.accepted).toBe(false);
  });

  it("sin destino, nulo", () => {
    expect(readPlansForm(form(FULL.filter(([k]) => k !== "volver")))?.returnTo).toBeNull();
  });
});

describe("PA-04, lo que se dice con cada respuesta", () => {
  it.each([
    [{ kind: "has_access" }, "has_access"],
    [{ kind: "in_progress" }, "in_progress"],
    [{ kind: "changed" }, "changed"],
    [{ kind: "unavailable" }, "unavailable"],
    [{ kind: "invalid" }, "invalid"],
    [{ kind: "not_allowed", reason: "email_unverified" }, "email_unverified"],
    [{ kind: "not_allowed", reason: "suspended" }, "suspended"],
    [{ kind: "not_allowed", reason: "no_actor" }, "unavailable"],
  ] as const)("%j se dice %s", (answer, said) => {
    expect(plansAnswerOf(answer)).toBe(said);
  });
});

describe("PA-04, cifras y direcciones", () => {
  it("el precio es el total en pesos, con sus centavos", () => {
    expect(priceText(34900)).toBe("$349.00");
    expect(priceText(349000)).toBe("$3,490.00");
  });

  it("lo que equivale al mes del anual se redondea hacia abajo al centavo", () => {
    expect(monthlyEquivalent(349000)).toBe(29083);
    expect(monthlyEquivalent(12)).toBe(1);
  });

  it("la dirección lleva el plan y el destino solo si los hay", () => {
    expect(plansHref(null, null)).toBe("/planes");
    expect(plansHref("annual", null)).toBe("/planes?plan=annual");
    expect(plansHref("monthly", "/cursos/uno?x=1")).toBe("/planes?plan=monthly&volver=%2Fcursos%2Funo%3Fx%3D1");
  });

  it("PA-32 lleva la sesión", () => {
    expect(confirmingHref("cs_test_abc")).toBe("/suscripcion/confirmando?sesion=cs_test_abc");
  });

  it("de la dirección: el plan si existe, el destino que la lista admite, y si se volvió sin pagar", () => {
    const resolve = (input: string) => (input.startsWith("/cursos/") ? input : null);
    expect(readPlansQuery({ plan: "annual", volver: "/cursos/uno", cancelado: "1" }, resolve)).toEqual({ plan: "annual", returnTo: "/cursos/uno", canceled: true });
    expect(readPlansQuery({ plan: "weekly", volver: "https://otro.example", cancelado: "si" }, resolve)).toEqual({ plan: null, returnTo: null, canceled: false });
    expect(readPlansQuery({ plan: ["monthly", "annual"] }, resolve)).toEqual({ plan: null, returnTo: null, canceled: false });
  });
});
