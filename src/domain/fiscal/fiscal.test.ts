import { describe, expect, it } from "vitest";

import { clabeCheckDigit, parseClabe } from "./clabe";
import { acceptsPayee, TAX_REGIMES, taxRegimeOf } from "./regime";
import { parseRfc } from "./rfc";

// Las reglas de los datos fiscales del maestro (RF-510; T-409). CLABE: la estructura y el dígito de control de Banxico
// (Circular 12/2018). RFC: el patrón de `tdCFDI.xsd` del SAT, más una fecha que exista. Régimen: `c_RegimenFiscal` del
// catálogo del SAT `catCFDI_V_4_20261029`, leído de sus celdas el 2026-10-31.

describe("CLABE", () => {
  it.each([
    // El ejemplo del anexo de Banxico.
    ["00218003224094670", 0],
    ["00201007777777777", 1],
    ["03218000011835971", 9],
  ])("el dígito de control de %s es %i", (first, digit) => {
    expect(clabeCheckDigit(first)).toBe(digit);
  });

  it.each(["002180032240946700", "002010077777777771", "032180000118359719"])("%s vale", (clabe) => {
    expect(parseClabe(clabe)).toEqual({ ok: true, clabe, last4: clabe.slice(-4) });
  });

  it("los espacios y guiones de quien la copia no cuentan", () => {
    expect(parseClabe(" 002 010 07777777777-1 ")).toEqual({ ok: true, clabe: "002010077777777771", last4: "7771" });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["00201007777777777", "length"],
    ["0020100777777777711", "length"],
    ["00201007777777777a", "length"],
    ["٠٠٢٠١٠٠٧٧٧٧٧٧٧٧٧٧١", "length"],
    ["002010077777777772", "check_digit"],
    ["102010077777777771", "check_digit"],
    // Su dígito de control cuadra, pero no es de nadie.
    ["000000000000000000", "check_digit"],
  ])("%j no vale: %s", (input, reason) => {
    expect(parseClabe(input)).toEqual({ ok: false, reason });
  });

  it("detecta cualquier dígito cambiado", () => {
    const good = "002010077777777771";
    for (let position = 0; position < 18; position += 1) {
      const digit = Number(good[position]);
      const changed = `${good.slice(0, position)}${(digit + 1) % 10}${good.slice(position + 1)}`;
      expect(parseClabe(changed), changed).toEqual({ ok: false, reason: "check_digit" });
    }
  });
});

describe("RFC", () => {
  it.each([
    ["GOMA800101AB1", "person"],
    ["ÑOMA800101AB1", "person"],
    ["GOM&800101AB1", "person"],
    ["GOM800101AB1", "company"],
    ["G&M800229XY9", "company"],
  ] as const)("%s vale: %s", (rfc, kind) => {
    expect(parseRfc(rfc)).toEqual({ ok: true, rfc, kind });
  });

  it("mayúsculas, sin espacios ni guiones", () => {
    expect(parseRfc(" goma-800101 ab1 ")).toEqual({ ok: true, rfc: "GOMA800101AB1", kind: "person" });
  });

  it.each([
    ["", "empty"],
    ["  - ", "empty"],
    ["GOMA800101AB", "form"],
    ["GOMA800101AB12", "form"],
    ["GO1A800101AB1", "form"],
    // El último carácter es un dígito o una A.
    ["GOMA800101ABC", "form"],
    ["GOMA801301AB1", "form"],
    ["GOMA800132AB1", "form"],
    ["GOMA800001AB1", "form"],
  ])("%j no vale: %s", (input, reason) => {
    expect(parseRfc(input)).toEqual({ ok: false, reason });
  });

  it.each(["GOMA800230AB1", "GOMA800431AB1", "GOMA810229AB1"])("una fecha que no existe no vale: %s", (input) => {
    expect(parseRfc(input)).toEqual({ ok: false, reason: "date" });
  });

  it("el año lleva dos dígitos: un 29 de febrero vale en un año bisiesto", () => {
    expect(parseRfc("GOMA000229AB1").ok).toBe(true);
    expect(parseRfc("GOMA720229AB1").ok).toBe(true);
    expect(parseRfc("GOMA240229AB1").ok).toBe(true);
    expect(parseRfc("GOMA250229AB1").ok).toBe(false);
  });

  it.each(["gßa800101ab1", "ſoma800101ab1", "ıoma800101ab1", "ﬁma800101ab1", "ﬀa800101ab1", "ＧＯＭＡ800101AB1"])(
    "un carácter que al pasar a mayúsculas se vuelve otro no entra: %s",
    (input) => {
      expect(parseRfc(input)).toEqual({ ok: false, reason: "form" });
    },
  );

  it("la Ñ descompuesta, como sale al copiar de un PDF, es una Ñ", () => {
    expect(parseRfc("N\u0303OMA800101AB1")).toEqual({ ok: true, rfc: "ÑOMA800101AB1", kind: "person" });
    expect(parseRfc("ñoma800101ab1")).toEqual({ ok: true, rfc: "ÑOMA800101AB1", kind: "person" });
  });

  it.each(["XAXX010101000", "XEXX010101000"])("el genérico %s no es el de nadie", (input) => {
    expect(parseRfc(input)).toEqual({ ok: false, reason: "generic" });
  });
});

describe("régimen fiscal", () => {
  it("las 19 claves del catálogo del SAT", () => {
    expect(TAX_REGIMES.map((regime) => regime.code)).toEqual([
      "601", "603", "605", "606", "607", "608", "610", "611", "612", "614", "615", "616", "620", "621", "622", "623", "624", "625", "626",
    ]);
  });

  it.each([
    ["612", "person", true],
    ["612", "company", false],
    ["601", "company", true],
    ["601", "person", false],
    // Las dos que aplican a los dos tipos.
    ["626", "person", true],
    ["626", "company", true],
    ["610", "person", true],
    ["610", "company", true],
  ] as const)("%s con %s: %s", (code, payee, expected) => {
    expect(acceptsPayee(code, payee)).toBe(expected);
  });

  it.each(["", "609", "628", "612 ", "abc", 612, null])("%j no es una clave", (value) => {
    expect(taxRegimeOf(value)).toBeNull();
  });

  it("una clave del catálogo es esa clave", () => {
    expect(taxRegimeOf("626")).toBe("626");
  });
});
