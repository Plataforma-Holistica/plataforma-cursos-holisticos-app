import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CATALOG_NAME_MAX_LENGTH, parseCatalogName } from "./name";

// El nombre de una práctica o un nivel (RF-709). La base revisa lo mismo y manda; estas
// pruebas fijan la regla de este lado, con los mismos casos que prueba la base en
// `supabase/tests/17_listas.test.sql`. Lo que una deje pasar y la otra no, la persona lo ve
// como «no tiene forma» en su campo.

describe("parseCatalogName", () => {
  it.each([
    ["un nombre corriente", "Yoga", "Yoga"],
    ["con acentos", "Meditación guiada", "Meditación guiada"],
    ["con espacios en los extremos", "  Reiki  ", "Reiki"],
    ["con un número", "Nivel 2", "Nivel 2"],
    ["con signos, si hay letras", "Tai chi (estilo Chen)", "Tai chi (estilo Chen)"],
    ["del tope exacto", "a".repeat(40), "a".repeat(40)],
    ["descompuesto (NFD), que se guarda compuesto", "Ba\u0301sico", "Básico"],
    ["con un espacio duro en medio, que no es de formato", "Tai\u00a0chi", "Tai\u00a0chi"],
  ])("acepta %s", (_name, input, name) => {
    expect(parseCatalogName(input)).toEqual({ ok: true, name });
  });

  it.each([
    ["nulo", null],
    ["la cadena vacía", ""],
    ["solo espacios", "   "],
    ["solo un carácter de ancho cero en los extremos, que trim quita", "\ufeff"],
  ])("trata como vacío %s", (_name, input) => {
    expect(parseCatalogName(input)).toEqual({ ok: false, reason: "empty" });
  });

  it.each([
    ["de 41 caracteres", "a".repeat(41)],
    ["de 41 caracteres que en UTF-16 serían más", "😀".repeat(41)],
    ["desmedido, sin llegar a normalizarlo", "a".repeat(401)],
  ])("rechaza por largo %s", (_name, input) => {
    expect(parseCatalogName(input)).toEqual({ ok: false, reason: "too_long" });
  });

  it("cuenta caracteres y no unidades de UTF-16: cuarenta emojis con una letra caben si son 40", () => {
    expect(parseCatalogName(`a${"😀".repeat(39)}`)).toEqual({ ok: true, name: `a${"😀".repeat(39)}` });
  });

  it.each([
    ["con un salto de línea", "Tai\nchi"],
    ["con un tabulador", "Tai\tchi"],
    ["con un guion suave", "Yo\u00adga"],
    ["con un carácter de ancho cero", "Yo\u200bga"],
    ["con uno que invierte la dirección", "\u202eagoY"],
    ["con uno que aísla la dirección", "Yoga\u2066x"],
    ["con una etiqueta", "Yo\u{e0041}ga"],
    ["solo signos, que dejan el slug vacío", "¡¡!!"],
    ["sin letras latinas, que dejan el slug vacío", "瑜伽"],
  ])("rechaza %s", (_name, input) => {
    expect(parseCatalogName(input)).toEqual({ ok: false, reason: "invalid" });
  });

  it("lo que acepta sale en NFC, sin espacios en los extremos y dentro del tope", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 60 }), (input) => {
        const result = parseCatalogName(input);
        if (!result.ok) return;
        expect(result.name).toBe(result.name.normalize("NFC"));
        expect(result.name).toBe(result.name.trim());
        expect([...result.name].length).toBeLessThanOrEqual(CATALOG_NAME_MAX_LENGTH);
        expect(result.name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      }),
    );
  });

  it("escribirlo descompuesto o compuesto da lo mismo", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 30 }), (input) => {
        expect(parseCatalogName(input.normalize("NFD"))).toEqual(parseCatalogName(input.normalize("NFC")));
      }),
    );
  });
});
