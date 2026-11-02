import { describe, expect, it } from "vitest";

import { clabeCheckDigit } from "./clabe";
import { checkTaxForm, LEGAL_NAME_MAX_LENGTH, maskTail, parseLegalName } from "./tax-form";

const first17 = "01218000123456789";
const CLABE = `${first17}${clabeCheckDigit(first17)}`;
const PERSON = { rfc: "GODE561231GR8", regime: "626", legalName: "Elena Gómez Díaz", clabe: CLABE };
const COMPANY = { rfc: "ABC680524P76", regime: "601", legalName: "Calma, S.A. de C.V.", clabe: CLABE };

describe("la razón social", () => {
  it.each([
    ["  Elena   Gómez ", "Elena Gómez"],
    ["Calma, S.A.", "Calma, S.A."],
    ["Niño", "Niño"],
  ])("%j se guarda como %j", (input, name) => {
    expect(parseLegalName(input)).toEqual({ ok: true, name });
  });

  it("vacía, o solo con espacios, falta", () => {
    expect(parseLegalName("")).toEqual({ ok: false, reason: "empty" });
    expect(parseLegalName("  \t ")).toEqual({ ok: false, reason: "empty" });
  });

  it("cabe hasta el tope, y uno más no", () => {
    expect(parseLegalName("a".repeat(LEGAL_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(parseLegalName("a".repeat(LEGAL_NAME_MAX_LENGTH + 1))).toEqual({ ok: false, reason: "long" });
  });

  it.each(["Ana\u0000", "Ana\u0007B", "Ana​B", "Ana‮B"])("no acepta caracteres que no se ven: %j", (input) => {
    expect(parseLegalName(input)).toEqual({ ok: false, reason: "form" });
  });
});

describe("el formulario entero", () => {
  it("de una persona física: sale limpio, con el tipo que dice su RFC y los últimos cuatro", () => {
    expect(checkTaxForm({ ...PERSON, rfc: " gode-561231-gr8 ", clabe: `${CLABE.slice(0, 3)} ${CLABE.slice(3)}` })).toEqual({
      ok: true,
      value: { rfc: "GODE561231GR8", payee: "person", regime: "626", legalName: "Elena Gómez Díaz", clabe: CLABE, last4: CLABE.slice(-4) },
    });
  });

  it("de una persona moral", () => {
    const result = checkTaxForm(COMPANY);
    expect(result.ok && result.value.payee).toBe("company");
  });

  it("dice cada campo que falta", () => {
    expect(checkTaxForm({ rfc: "", regime: "", legalName: "", clabe: "" })).toEqual({
      ok: false,
      problems: { rfc: "required", regime: "required", legalName: "required", clabe: "required" },
    });
  });

  it.each([
    ["rfc", "ABC", "form"],
    ["rfc", "GODE560231GR8", "date"],
    ["rfc", "XAXX010101000", "generic"],
    ["regime", "999", "form"],
    ["legalName", "a".repeat(LEGAL_NAME_MAX_LENGTH + 1), "long"],
    ["legalName", "Ana\u0007", "form"],
    ["clabe", "123", "length"],
    ["clabe", `${first17}${(clabeCheckDigit(first17) + 1) % 10}`, "check_digit"],
  ])("%s con %j: %s", (field, value, problem) => {
    expect(checkTaxForm({ ...PERSON, [field]: value })).toEqual({ ok: false, problems: { [field]: problem } });
  });

  it("un régimen que no es de ese tipo de persona se marca en el régimen", () => {
    expect(checkTaxForm({ ...PERSON, regime: "601" })).toEqual({ ok: false, problems: { regime: "payee" } });
    expect(checkTaxForm({ ...COMPANY, regime: "605" })).toEqual({ ok: false, problems: { regime: "payee" } });
  });

  it("con el RFC malo no se puede decir si el régimen le toca: solo se marca el RFC", () => {
    expect(checkTaxForm({ ...PERSON, rfc: "ABC", regime: "601" })).toEqual({ ok: false, problems: { rfc: "form" } });
  });
});

describe("lo que se muestra de un dato guardado", () => {
  it("son los últimos cuatro caracteres", () => {
    expect(maskTail(CLABE)).toBe(`•••• ${CLABE.slice(-4)}`);
    expect(maskTail("GODE561231GR8")).toBe("•••• 1GR8");
  });

  it("cuenta caracteres, no unidades de código", () => {
    expect(maskTail("abc𝒶𝒷𝒸𝒹")).toBe("•••• 𝒶𝒷𝒸𝒹");
  });

  it("un dato de cuatro caracteres o menos no se muestra: se vería entero", () => {
    expect(maskTail("Ana")).toBe("••••");
    expect(maskTail("Anas")).toBe("••••");
    expect(maskTail("Anais")).toBe("•••• nais");
  });
});
