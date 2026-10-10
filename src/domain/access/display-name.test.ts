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
    ["un separador de línea de Unicode dentro", "Ana Pérez"],
    ["un separador de párrafo de Unicode dentro", "Ana Pérez"],
    ["una marca que invierte la dirección del texto", "Ana‮zeréP"],
    ["una marca de aislamiento de dirección", "Ana⁦Pérez"],
    ["un espacio de ancho cero dentro", "Ana​Pérez"],
    ["la marca de orden de bytes dentro", "Ana﻿Pérez"],
    ["una mitad suelta de un carácter", "Ana\ud83d"],
    ["solo un relleno que Unicode cuenta como letra", "ㅤ"],
    ["solo rellenos de otro bloque", "ᅟᅠ"],
    ["solo el relleno de ancho medio", "ﾠ"],
    ["un relleno junto a un nombre real", "Anaㅤ"],
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

  // Nombres plausibles con ruido alrededor y en medio, para que la propiedad sí llegue a
  // nombres aceptados: con texto al azar casi ninguno lo sería.
  const piece = fc.constantFrom("Ana", "Pérez", "山田", "José", "2", "O'Brien", "-", " ", "  ", "\t", "\n", "​", "ㅤ", "😀", ".");
  const candidate = fc.array(piece, { maxLength: 8 }).map((pieces) => pieces.join(""));

  it("lo que acepta se vuelve a aceptar igual: guardarlo y releerlo no cambia nada", () => {
    fc.assert(
      fc.property(candidate, (input) => {
        const first = parseDisplayName(input);
        if (!first.ok) return;
        expect(parseDisplayName(first.name)).toEqual(first);
        expect([...first.name].length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
        expect(first.name).toBe(input.trim());
        // Lo aceptado se ve: trae una letra o un número, y nada que rompa una línea.
        expect(first.name).toMatch(/[\p{L}\p{N}]/u);
        expect(first.name).not.toMatch(/[\n\t​ㅤ]/u);
      }),
    );
  });

  it("los generadores sí producen nombres aceptados y rechazados", () => {
    const outcomes = fc.sample(candidate, 500).map((input) => parseDisplayName(input));
    expect(outcomes.filter((outcome) => outcome.ok).length).toBeGreaterThan(50);
    expect(outcomes.filter((outcome) => !outcome.ok).length).toBeGreaterThan(50);
  });
});
