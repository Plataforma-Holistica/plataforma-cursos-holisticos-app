import { describe, expect, it } from "vitest";

import { LEGAL_BODY_MAX_LENGTH, LEGAL_TITLE_MAX_LENGTH, parseLegalBody, parseLegalDay, parseLegalTitle } from "./version";

// Las reglas de una versión nueva de un texto legal (PA-89, T-110). Son las de la base
// (`private.publish_legal_document()`, probada en `supabase/tests/56_textos_legales.test.sql`): aquí, que el
// servicio y la pantalla las revisen igual antes de preguntar.

describe("el título", () => {
  it.each([
    ["  Términos  ", "Términos"],
    ["Aviso de privacidad", "Aviso de privacidad"],
    ["Café", "Café"],
  ])("«%s» se guarda como «%s»: en NFC y sin espacios a los lados", (input, title) => {
    expect(parseLegalTitle(input)).toEqual({ ok: true, title });
  });

  it.each([
    [null, "empty"],
    ["", "empty"],
    ["   ", "empty"],
    ["t".repeat(LEGAL_TITLE_MAX_LENGTH + 1), "too_long"],
    ["x".repeat(5_000), "too_long"],
    ["Re\u0007embolsos", "invalid"],
    ["Dos\nrenglones", "invalid"],
  ] as const)("%j no pasa: %s", (input, reason) => {
    expect(parseLegalTitle(input)).toEqual({ ok: false, reason });
  });

  it("doscientos caracteres sí, contados como caracteres y no como unidades de UTF-16", () => {
    expect(parseLegalTitle("t".repeat(LEGAL_TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(parseLegalTitle("😀".repeat(LEGAL_TITLE_MAX_LENGTH)).ok).toBe(true);
  });
});

describe("el texto", () => {
  it("los finales de renglón de un formulario se vuelven saltos de línea; nada más se toca", () => {
    expect(parseLegalBody("Uno\r\nDos\rTres\n\tCuatro  ")).toEqual({ ok: true, body: "Uno\nDos\nTres\n\tCuatro  " });
  });

  it.each([
    [null, "empty"],
    ["", "empty"],
    [" \n\t \r\n ", "empty"],
    ["a".repeat(LEGAL_BODY_MAX_LENGTH + 1), "too_long"],
    ["Uno\u0001dos", "invalid"],
    ["Uno\u000bdos", "invalid"],
    ["Uno\u007fdos", "invalid"],
  ] as const)("%j no pasa: %s", (input, reason) => {
    expect(parseLegalBody(input === null ? null : input)).toEqual({ ok: false, reason });
  });

  it("el tope cuenta caracteres: 200 000 pasan", () => {
    expect(parseLegalBody("a".repeat(LEGAL_BODY_MAX_LENGTH)).ok).toBe(true);
  });
});

describe("el día de vigencia, contra el de hoy en la zona del periodo", () => {
  const TODAY = "2026-10-28";

  it.each([
    ["2026-10-28", "hoy"],
    ["2026-10-29", "mañana"],
    ["2027-10-29", "a 366 días"],
    [" 2026-11-01 ", "con espacios a los lados"],
  ])("%s pasa (%s)", (input) => {
    expect(parseLegalDay(input, TODAY)).toEqual({ ok: true, day: input.trim() });
  });

  it.each([
    [null, "empty"],
    ["", "empty"],
    ["2026-10-27", "past"],
    ["2027-10-30", "too_far"],
    ["2026-02-30", "invalid"],
    ["28/10/2026", "invalid"],
    ["2026-10-28T00:00", "invalid"],
  ] as const)("%j no pasa: %s", (input, reason) => {
    expect(parseLegalDay(input, TODAY)).toEqual({ ok: false, reason });
  });

  it("sin un día de hoy que se entienda, ningún día pasa", () => {
    expect(parseLegalDay("2026-10-28", "")).toEqual({ ok: false, reason: "invalid" });
  });
});
