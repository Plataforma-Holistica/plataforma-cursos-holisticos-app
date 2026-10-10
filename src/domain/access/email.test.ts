import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EMAIL_MAX_LENGTH, parseEmail } from "./email";

// La forma de un correo y su forma normalizada (TRD §5.1, RF-101). La normalizada es la
// que se manda a Auth y de la que el servicio calcula la huella del freno: tiene que
// coincidir con lo que Auth considera la misma cuenta (pasa el correo a minúsculas).

describe("parseEmail", () => {
  it("acepta un correo corriente y lo deja igual", () => {
    expect(parseEmail("ana@ejemplo.com")).toEqual({
      ok: true,
      email: "ana@ejemplo.com",
      mailbox: "ana@ejemplo.com",
    });
  });

  it("quita los espacios de los extremos y pasa a minúsculas", () => {
    expect(parseEmail("  Ana.Perez@Ejemplo.COM \n")).toMatchObject({
      ok: true,
      email: "ana.perez@ejemplo.com",
    });
  });

  it("la clave del buzón no lleva la etiqueta que sigue al signo de más", () => {
    expect(parseEmail("ana+cursos@ejemplo.com")).toEqual({
      ok: true,
      email: "ana+cursos@ejemplo.com",
      mailbox: "ana@ejemplo.com",
    });
  });

  it("un signo de más al inicio no es una etiqueta", () => {
    expect(parseEmail("+ana@ejemplo.com")).toMatchObject({ ok: true, mailbox: "+ana@ejemplo.com" });
  });

  it.each(["", "   ", "\t\n"])("rechaza el correo vacío «%s»", (input) => {
    expect(parseEmail(input)).toEqual({ ok: false, reason: "empty" });
  });

  it("rechaza un correo más largo que el máximo", () => {
    const local = "a".repeat(64);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`;
    expect(`${local}@${domain}`.length).toBeGreaterThan(EMAIL_MAX_LENGTH);
    expect(parseEmail(`${local}@${domain}`)).toEqual({ ok: false, reason: "too_long" });
  });

  it.each([
    ["sin arroba", "ana.ejemplo.com"],
    ["con dos arrobas", "ana@casa@ejemplo.com"],
    ["sin parte local", "@ejemplo.com"],
    ["sin dominio", "ana@"],
    ["con el dominio sin punto", "ana@localhost"],
    ["con un espacio dentro", "ana perez@ejemplo.com"],
    ["con un punto al inicio", ".ana@ejemplo.com"],
    ["con dos puntos seguidos", "ana..perez@ejemplo.com"],
    ["con un punto antes de la arroba", "ana.@ejemplo.com"],
    ["con una etiqueta de dominio vacía", "ana@ejemplo..com"],
    ["con un guion al inicio de una etiqueta", "ana@-ejemplo.com"],
    ["con un guion al final de una etiqueta", "ana@ejemplo-.com"],
    ["con una etiqueta de más de 63 caracteres", `ana@${"b".repeat(64)}.com`],
    ["con la parte local de más de 64 caracteres", `${"a".repeat(65)}@ejemplo.com`],
    ["con comillas", '"ana perez"@ejemplo.com'],
    ["con un carácter de control", "ana\u0000@ejemplo.com"],
    ["con eñe", "peña@ejemplo.com"],
    ["con acento en el dominio", "ana@educación.mx"],
  ])("rechaza un correo %s", (_name, input) => {
    expect(parseEmail(input)).toEqual({ ok: false, reason: "malformed" });
  });

  // El signo de Kelvin (U+212A) pasa a «k» al convertir a minúsculas: si la revisión de
  // ASCII fuera después, dos textos distintos darían la misma huella.
  it("rechaza un carácter que solo parece ASCII después de pasar a minúsculas", () => {
    expect(parseEmail("Karla@ejemplo.com")).toEqual({ ok: false, reason: "malformed" });
  });

  it("normalizar dos veces da lo mismo", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (input) => {
        const first = parseEmail(input);
        if (!first.ok) return;
        expect(parseEmail(first.email)).toEqual(first);
      }),
    );
  });

  it("las mayúsculas y los espacios de los extremos no cambian el resultado", () => {
    fc.assert(
      fc.property(fc.emailAddress(), fc.constantFrom("", " ", "\t", "\n  "), (input, padding) => {
        const plain = parseEmail(input);
        expect(parseEmail(`${padding}${input.toUpperCase()}${padding}`)).toEqual(plain);
      }),
    );
  });

  it("lo que acepta sale en minúsculas, en ASCII visible y dentro del máximo", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (input) => {
        const result = parseEmail(input);
        if (!result.ok) return;
        expect(result.email).toMatch(/^[\x21-\x7e]+$/);
        expect(result.email).toBe(result.email.toLowerCase());
        expect(result.email.length).toBeLessThanOrEqual(EMAIL_MAX_LENGTH);
        expect(result.email.split("@")).toHaveLength(2);
      }),
    );
  });

  it("cualquier carácter fuera de ASCII hace que se rechace", () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.integer({ min: 0x80, max: 0xd7ff }),
        fc.nat(),
        (input, code, position) => {
          const at = position % (input.length + 1);
          const dirty = `${input.slice(0, at)}${String.fromCharCode(code)}${input.slice(at)}`;
          // Un espacio Unicode en un extremo se recorta: ahí el correo sigue siendo válido.
          fc.pre(dirty.trim() === dirty && dirty.length <= EMAIL_MAX_LENGTH);
          expect(parseEmail(dirty)).toEqual({ ok: false, reason: "malformed" });
        },
      ),
    );
  });
});
