import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { DISPLAY_NAME_MAX_LENGTH, parseDisplayName } from "./display-name";

// El único criterio de «nombre válido» (RF-109). Lo usan la guarda de sesión, para decidir
// si a una cuenta le falta el nombre, y los formularios que lo piden: si cada uno tuviera
// el suyo, una cuenta podría quedar dando vueltas entre los dos.

describe("parseDisplayName", () => {
  it.each([
    ["un nombre corriente", "Ana Pérez", "Ana Pérez"],
    ["un nombre con espacios en los extremos", "  Ana  ", "Ana"],
    ["una sola letra", "A", "A"],
    ["un nombre con números", "Ana 2", "Ana 2"],
    ["un nombre en otro alfabeto", "山田太郎", "山田太郎"],
    ["un nombre con apóstrofo y guion", "O'Brien-Núñez", "O'Brien-Núñez"],
  ])("acepta %s", (_name, input, name) => {
    expect(parseDisplayName(input)).toEqual({ ok: true, name });
  });

  it.each([
    ["nulo", null],
    ["la cadena vacía", ""],
    ["solo espacios", "   "],
    ["solo saltos y tabuladores", "\n\t "],
  ])("trata como vacío %s", (_name, input) => {
    expect(parseDisplayName(input)).toEqual({ ok: false, reason: "empty" });
  });

  it.each([
    ["solo signos", "...---"],
    ["solo un espacio de ancho cero", "​"],
    ["solo emojis", "😀😀"],
    ["un carácter de control dentro", "Ana\u0000Pérez"],
    ["un salto de línea dentro", "Ana\nPérez"],
  ])("rechaza por inválido %s", (_name, input) => {
    expect(parseDisplayName(input)).toEqual({ ok: false, reason: "invalid" });
  });

  it("el máximo se cuenta en caracteres, como en la base, no en unidades", () => {
    const atLimit = "ñ".repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(parseDisplayName(atLimit)).toEqual({ ok: true, name: atLimit });
    expect(parseDisplayName(`${atLimit}ñ`)).toEqual({ ok: false, reason: "too_long" });
    // Ciento veinte emojis son doscientas cuarenta unidades y siguen cabiendo.
    const emojis = `a${"😀".repeat(DISPLAY_NAME_MAX_LENGTH - 1)}`;
    expect(parseDisplayName(emojis)).toEqual({ ok: true, name: emojis });
  });

  it("lo que acepta se vuelve a aceptar igual: guardarlo y releerlo no cambia nada", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 140 }), (input) => {
        const first = parseDisplayName(input);
        if (!first.ok) return;
        expect(parseDisplayName(first.name)).toEqual(first);
        expect([...first.name].length).toBeGreaterThanOrEqual(1);
        expect([...first.name].length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
        expect(first.name).toBe(first.name.trim());
      }),
    );
  });
});
