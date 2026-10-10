import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, checkPassword } from "./password-policy";

// La regla de la contraseña (TRD §9.2, fila «Registro»): mínimo de caracteres y máximo de
// bytes, sin reglas de composición. No se recorta ni se normaliza nada: lo que la persona
// escribió es lo que se manda.

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

describe("checkPassword", () => {
  it("los límites son los que fija el TRD", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_BYTES).toBe(72);
  });

  it.each([
    ["ocho letras", "abcdefgh"],
    ["ocho espacios", "        "],
    ["sin mayúsculas, números ni símbolos", "contrasena"],
    ["ocho emojis, que son ocho caracteres y treinta y dos bytes", "😀".repeat(8)],
    ["setenta y dos letras", "a".repeat(72)],
    ["treinta y seis eñes, que son setenta y dos bytes", "ñ".repeat(36)],
    ["veinticuatro caracteres de tres bytes", "あ".repeat(24)],
  ])("acepta %s", (_name, password) => {
    expect(checkPassword(password)).toEqual({ ok: true });
  });

  it.each([
    ["la cadena vacía", ""],
    ["siete letras", "abcdefg"],
    ["siete emojis, aunque sean catorce unidades y veintiocho bytes", "😀".repeat(7)],
    ["cuatro eñes, aunque sean ocho bytes", "ñ".repeat(4)],
  ])("rechaza por corta %s", (_name, password) => {
    expect(checkPassword(password)).toEqual({ ok: false, reason: "too_short" });
  });

  it.each([
    ["setenta y tres letras", "a".repeat(73)],
    ["treinta y siete eñes, que son setenta y cuatro bytes", "ñ".repeat(37)],
    ["diecinueve emojis, que son setenta y seis bytes", "😀".repeat(19)],
    ["veinticinco caracteres de tres bytes", "あ".repeat(25)],
  ])("rechaza por larga %s", (_name, password) => {
    expect(checkPassword(password)).toEqual({ ok: false, reason: "too_long" });
  });

  // Los bordes de cada tamaño en UTF-8. Cada pareja fija un límite: el último carácter que
  // ocupa tantos bytes, y el primero que ocupa uno más.
  it.each([
    ["de un byte, el último (U+007E)", "~", 72],
    ["de dos bytes, el primero imprimible (U+00A0)", " ", 36],
    ["de dos bytes, una vocal con acento", "é", 36],
    ["de dos bytes, el último (U+07FF)", "߿", 36],
    ["de tres bytes, el primero (U+0800)", "ࠀ", 24],
    ["de tres bytes, el último (U+FFFF)", "￿", 24],
    ["de cuatro bytes, el primero (U+10000)", "\u{10000}", 18],
  ])("con caracteres %s caben exactamente los que suman 72 bytes", (_name, char, fits) => {
    expect(utf8Bytes(char.repeat(fits))).toBe(72);
    expect(checkPassword(char.repeat(fits))).toEqual({ ok: true });
    expect(checkPassword(char.repeat(fits + 1))).toEqual({ ok: false, reason: "too_long" });
  });

  it.each([
    ["un carácter nulo", "abcd\u0000efgh"],
    ["un tabulador", "abcd\tefgh"],
    ["un salto de línea", "abcdefgh\n"],
    ["el carácter de borrado (U+007F)", "abcd\u007fefgh"],
    ["un control de la segunda serie (U+0080)", "abcd\u0080efgh"],
    ["el último control de la segunda serie (U+009F)", "abcd\u009fefgh"],
  ])("rechaza por mal formada una contraseña con %s", (_name, password) => {
    expect(checkPassword(password)).toEqual({ ok: false, reason: "malformed" });
  });

  it("el espacio, que es el primer carácter que no es de control, sí vale", () => {
    expect(checkPassword(" ".repeat(8))).toEqual({ ok: true });
    expect(checkPassword("\u001f".repeat(8))).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["una mitad alta suelta al final", "abcdefgh\ud83d"],
    ["una mitad alta seguida de una letra", "abcd\ud83defgh"],
    ["una mitad baja suelta", "abcd\ude00efgh"],
    ["las dos mitades al revés", "abcdefgh\ude00\ud83d"],
  ])("rechaza por mal formada %s", (_name, password) => {
    expect(checkPassword(password)).toEqual({ ok: false, reason: "malformed" });
  });

  // Piezas de uno a cuatro bytes, mitades sueltas y un carácter de control, en cantidades
  // que cruzan los dos límites: con texto al azar casi nunca se llega a 72 bytes.
  const piece = fc.constantFrom("a", "~", "é", "߿", "ࠀ", "あ", "￿", "😀", "\u{10000}");
  const odd = fc.constantFrom("\ud83d", "\ude00", "\u0007", "\u0085");
  const anyPassword = fc
    .array(fc.oneof({ weight: 30, arbitrary: piece }, { weight: 1, arbitrary: odd }), { maxLength: 80, size: "max" })
    .map((pieces) => pieces.join(""));
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

  it("los generadores sí llegan a los cuatro resultados", () => {
    const seen = new Set(
      fc.sample(anyPassword, 2000).map((password) => {
        const result = checkPassword(password);
        return result.ok ? "ok" : result.reason;
      }),
    );
    expect([...seen].sort()).toEqual(["malformed", "ok", "too_long", "too_short"]);
  });

  it("coincide con contar puntos de código y bytes en UTF-8", () => {
    fc.assert(
      fc.property(anyPassword, (password) => {
        const result = checkPassword(password);
        const length = [...password].length;
        const bytes = utf8Bytes(password);
        if (!password.isWellFormed() || CONTROL.test(password)) {
          expect(result).toEqual({ ok: false, reason: "malformed" });
        } else if (length < PASSWORD_MIN_LENGTH) {
          expect(result).toEqual({ ok: false, reason: "too_short" });
        } else if (bytes > PASSWORD_MAX_BYTES) {
          expect(result).toEqual({ ok: false, reason: "too_long" });
        } else {
          expect(result).toEqual({ ok: true });
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("una mitad suelta en cualquier lugar la vuelve mal formada", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary-ascii", minLength: 8, maxLength: 40 }),
        fc.integer({ min: 0xd800, max: 0xdfff }),
        fc.nat(),
        (password, half, position) => {
          const at = position % (password.length + 1);
          const dirty = `${password.slice(0, at)}${String.fromCharCode(half)}${password.slice(at)}`;
          expect(checkPassword(dirty)).toEqual({ ok: false, reason: "malformed" });
        },
      ),
    );
  });
});
