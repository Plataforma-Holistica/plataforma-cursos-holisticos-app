import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseSecondFactorCode, SECOND_FACTOR_CODE_LENGTH } from "./second-factor-code";

// El código de la aplicación de códigos, como lo teclea o lo pega una persona (RF-106). El
// formulario lo revisa con esta regla antes de preguntarle a nadie: un código sin forma no
// es un intento, y no cuenta en el freno.

describe("parseSecondFactorCode", () => {
  it("mide seis dígitos", () => {
    expect(SECOND_FACTOR_CODE_LENGTH).toBe(6);
  });

  it.each([
    ["seis dígitos", "123456", "123456"],
    ["con ceros delante", "000042", "000042"],
    ["partido en dos, como lo muestran las aplicaciones", "123 456", "123456"],
    ["con espacios en los extremos", "  123456  ", "123456"],
    ["con un espacio sin corte, como llega al pegar", "123 456", "123456"],
    ["con tabulador y salto de línea", "123\t456\n", "123456"],
  ])("acepta %s", (_what, input, code) => {
    expect(parseSecondFactorCode(input)).toEqual({ ok: true, code });
  });

  it.each([
    ["nulo", null],
    ["nada", undefined],
    ["la cadena vacía", ""],
    ["solo espacios", "   "],
  ])("trata como vacío %s", (_what, input) => {
    expect(parseSecondFactorCode(input)).toEqual({ ok: false, reason: "empty" });
  });

  it.each([
    ["cinco dígitos", "12345"],
    ["siete dígitos", "1234567"],
    ["letras", "12a456"],
    ["un guion en medio", "123-456"],
    ["un punto", "123.456"],
    ["un signo", "+12345"],
    ["dígitos de otro alfabeto", "١٢٣٤٥٦"],
    ["dígitos de ancho completo", "１２３４５６"],
    ["un número, no un texto", 123456],
    ["una lista", ["123456"]],
    ["un objeto", { code: "123456" }],
    ["el código dictado de un restablecimiento", "K7QM2X9P"],
  ])("no tiene forma: %s", (_what, input) => {
    expect(parseSecondFactorCode(input)).toEqual({ ok: false, reason: "malformed" });
  });

  it("lo que acepta es siempre seis dígitos ASCII, sin nada más", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseSecondFactorCode(input);
        if (result.ok) expect(result.code).toMatch(/^[0-9]{6}$/);
      }),
    );
  });

  it("todo código de seis dígitos pasa, con espacios donde sea", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{6}$/), fc.nat({ max: 6 }), (code, at) => {
        const spaced = `${code.slice(0, at)} ${code.slice(at)}`;
        expect(parseSecondFactorCode(spaced)).toEqual({ ok: true, code });
      }),
    );
  });
});
