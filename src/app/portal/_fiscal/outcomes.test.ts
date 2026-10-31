import { describe, expect, it } from "vitest";

import { ROUTES } from "@/services/account/navigation";

import { readRevealForm, readTaxForm, revealOutcome, saveOutcome } from "./outcomes";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
const FIELDS = { rfc: "GODE561231GR8", regime: "626", legal_name: "Elena", clabe: "012180001234567895", seen: "2", password: "la-de-ella" };
const AT = "2026-10-31T18:00:00.000Z";

describe("lo que se lee del formulario", () => {
  it("cada campo, y la versión vista como número", () => {
    expect(readTaxForm(form(FIELDS))).toEqual({ rfc: "GODE561231GR8", regime: "626", legalName: "Elena", clabe: "012180001234567895", seen: 2, password: "la-de-ella" });
  });

  it("lo que falta o viene desmedido cuenta como vacío", () => {
    const read = readTaxForm(form({ ...FIELDS, rfc: "x".repeat(2_000), password: "x".repeat(2_000) }));
    expect(read.rfc).toBe("");
    expect(read.password).toBe("");
    expect(readTaxForm(new FormData())).toMatchObject({ rfc: "", regime: "", legalName: "", clabe: "", password: "", seen: null });
    expect(readRevealForm(new FormData())).toEqual({ password: "" });
  });

  it.each(["", "-1", "1.5", "x", "32767", "1e3", "00000001"])("una versión vista sin forma, %j, es nula", (seen) => {
    expect(readTaxForm(form({ ...FIELDS, seen })).seen).toBeNull();
  });

  it("un archivo en lugar de un texto cuenta como vacío", () => {
    const data = form(FIELDS);
    data.set("clabe", new File(["012180001234567895"], "a.txt"));
    expect(readTaxForm(data).clabe).toBe("");
  });
});

describe("ver lo guardado", () => {
  it("pinta lo oculto en parte, con la fecha en palabras", () => {
    const outcome = revealOutcome({ kind: "revealed", data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: "•••• 7771", updatedAt: AT } }, 3);
    expect(outcome.kind).toBe("repaint");
    if (outcome.kind !== "repaint") return;
    expect(outcome.state).toMatchObject({ kind: "revealed", data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: "•••• 7771" }, attempt: 3 });
  });

  it.each([
    [{ kind: "wrong_password" }, "wrong_password"],
    [{ kind: "capped" }, "capped"],
    [{ kind: "unavailable" }, "unavailable"],
    [{ kind: "off" }, "off"],
    [{ kind: "no_profile" }, "no_profile"],
  ] as const)("%j se dice en el bloque", (result, reason) => {
    expect(revealOutcome(result, 1)).toEqual({ kind: "repaint", state: { kind: "failed", reason, attempt: 1 } });
  });

  it("el freno lleva su hora, como texto", () => {
    expect(revealOutcome({ kind: "throttled", retryAt: new Date(AT) }, 1)).toEqual({ kind: "repaint", state: { kind: "throttled", retryAt: AT, attempt: 1 } });
  });

  it("quien ya no es maestro se va al portal, y la guarda decide", () => {
    expect(revealOutcome({ kind: "not_teacher" }, 1)).toEqual({ kind: "leave", to: ROUTES.portal, notice: null });
  });

  it("una sesión que ya no vale se cierra", () => {
    expect(revealOutcome({ kind: "session", check: { kind: "must_sign_out", then: "sign_in" } as never }, 1)).toEqual({
      kind: "leave",
      to: ROUTES.signIn,
      notice: null,
      closeSession: true,
    });
  });

  it("«no se supo» de la guarda no se trata como «sin sesión»", () => {
    expect(revealOutcome({ kind: "session", check: { kind: "unavailable" } }, 1)).toEqual({
      kind: "repaint",
      state: { kind: "failed", reason: "unavailable", attempt: 1 },
    });
  });
});

describe("guardar", () => {
  it("guardado, vuelve a la pantalla con su aviso: ningún dato en la respuesta y nada que reenviar", () => {
    expect(saveOutcome({ kind: "saved" }, 1)).toEqual({ kind: "leave", to: ROUTES.portalTaxData, notice: "tax_data_saved" });
  });

  it("lo que no pasó se dice por campo", () => {
    expect(saveOutcome({ kind: "invalid", problems: { clabe: "length" } }, 1)).toEqual({
      kind: "repaint",
      refresh: false,
      state: { kind: "invalid", problems: { clabe: "length" }, attempt: 1 },
    });
  });

  it.each([
    ["changed", true],
    ["suspended", true],
    ["wrong_password", false],
    ["capped", false],
    ["unavailable", false],
    ["off", false],
  ] as const)("%s se dice en el bloque, y la página se vuelve a pedir si cambió lo que pinta", (kind, refresh) => {
    expect(saveOutcome({ kind } as never, 1)).toEqual({ kind: "repaint", refresh, state: { kind: "failed", reason: kind, attempt: 1 } });
  });

  it("el freno lleva su hora", () => {
    expect(saveOutcome({ kind: "throttled", retryAt: new Date(AT) }, 1)).toEqual({
      kind: "repaint",
      refresh: false,
      state: { kind: "throttled", retryAt: AT, attempt: 1 },
    });
  });

  it("quien ya no es maestro se va al portal", () => {
    expect(saveOutcome({ kind: "not_teacher" }, 1)).toEqual({ kind: "leave", to: ROUTES.portal, notice: null });
  });
});
