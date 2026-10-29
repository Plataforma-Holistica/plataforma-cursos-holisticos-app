import { describe, expect, it } from "vitest";

import { DRAFT_TEXT_LIMITS, parseDraftText } from "./draft-text";

// Los textos del borrador (T-402). La base revisa lo mismo y manda; estas pruebas fijan la regla de
// este lado, con los casos que prueba la base en `supabase/tests/37_borrador.test.sql`.

describe("parseDraftText", () => {
  it("los largos son los que decidió Sergio", () => {
    expect(DRAFT_TEXT_LIMITS).toEqual({ courseTitle: 60, summary: 500, moduleTitle: 120, lessonTitle: 120, description: 2000 });
  });

  it.each([
    ["un título corriente", "courseTitle", "Respirar en calma", "Respirar en calma"],
    ["con espacios en las puntas", "lessonTitle", "  Una lección  ", "Una lección"],
    ["del tope exacto", "courseTitle", "a".repeat(60), "a".repeat(60)],
    ["descompuesto (NFD), que se guarda compuesto", "moduleTitle", "Ba\u0301sico", "Básico"],
    ["un resumen de varias líneas", "summary", "Primera.\nSegunda.", "Primera.\nSegunda."],
    ["con los saltos de Windows, que quedan en uno", "description", "Uno.\r\nDos.\rTres.", "Uno.\nDos.\nTres."],
    ["una descripción del tope exacto", "description", "d".repeat(2000), "d".repeat(2000)],
  ] as const)("acepta %s", (_name, kind, input, text) => {
    expect(parseDraftText(kind, input)).toEqual({ ok: true, text });
  });

  it.each([
    ["un resumen vacío", "summary", ""],
    ["una descripción de puros espacios", "description", "  \n  "],
    ["un resumen nulo", "summary", null],
  ] as const)("deja en nulo %s", (_name, kind, input) => {
    expect(parseDraftText(kind, input)).toEqual({ ok: true, text: null });
  });

  it.each([
    ["un título vacío", "courseTitle", ""],
    ["un título nulo", "lessonTitle", null],
    ["un título de puros espacios", "moduleTitle", "   "],
  ] as const)("trata como vacío %s", (_name, kind, input) => {
    expect(parseDraftText(kind, input)).toEqual({ ok: false, reason: "empty" });
  });

  it.each([
    ["un título de 61", "courseTitle", "a".repeat(61)],
    ["un título de módulo de 121", "moduleTitle", "m".repeat(121)],
    ["un resumen de 501", "summary", "r".repeat(501)],
    ["una descripción de 2 001", "description", "d".repeat(2001)],
    ["un título que en UTF-16 sería más largo, de 61 caracteres", "courseTitle", "😀".repeat(61)],
    ["desmedido, sin llegar a normalizarlo", "courseTitle", "a".repeat(241)],
  ] as const)("rechaza por largo %s", (_name, kind, input) => {
    expect(parseDraftText(kind, input)).toEqual({ ok: false, reason: "too_long" });
  });

  it("cuenta caracteres y no unidades de UTF-16", () => {
    expect(parseDraftText("courseTitle", "😀".repeat(60))).toEqual({ ok: true, text: "😀".repeat(60) });
  });

  it.each([
    ["un salto de línea en un título", "courseTitle", "Respirar\nen calma"],
    ["un tabulador en un resumen", "summary", "Uno\tdos"],
    ["un carácter de ancho cero", "lessonTitle", "Respi\u200brar"],
    ["un control C1", "description", "Uno\u0085dos"],
    ["un aislador de dirección", "moduleTitle", "Uno\u2066dos"],
  ] as const)("rechaza %s", (_name, kind, input) => {
    expect(parseDraftText(kind, input)).toEqual({ ok: false, reason: "invalid" });
  });
});
