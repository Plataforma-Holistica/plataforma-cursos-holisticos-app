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

  it.each([
    ["una mitad alta suelta al final", "abcdefgh\ud83d"],
    ["una mitad alta seguida de una letra", "abcd\ud83defgh"],
    ["una mitad baja suelta", "abcd\ude00efgh"],
    ["las dos mitades al revés", "abcdefgh\ude00\ud83d"],
  ])("rechaza por mal formada %s", (_name, password) => {
    expect(checkPassword(password)).toEqual({ ok: false, reason: "malformed" });
  });

  it("coincide con contar puntos de código y bytes en UTF-8", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 90 }), (password) => {
        const result = checkPassword(password);
        const length = [...password].length;
        const bytes = utf8Bytes(password);
        if (!password.isWellFormed()) {
          expect(result).toEqual({ ok: false, reason: "malformed" });
        } else if (length < PASSWORD_MIN_LENGTH) {
          expect(result).toEqual({ ok: false, reason: "too_short" });
        } else if (bytes > PASSWORD_MAX_BYTES) {
          expect(result).toEqual({ ok: false, reason: "too_long" });
        } else {
          expect(result).toEqual({ ok: true });
        }
      }),
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
