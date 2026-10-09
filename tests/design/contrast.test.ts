import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// La tabla de contraste del diseño (03, secciones 3.3 y 3.4), recalculada a partir de los
// tokens de src/ui/theme.css. El diseño la define como prueba automática: cambiar el
// acento por el de la marca no puede romper la accesibilidad sin que alguien se entere.
//
// Cada par se comprueba dos veces: que no baje de su mínimo (la regla) y que dé la cifra
// escrita en el documento (para que la tabla y la hoja no se separen). Si cambia un token,
// se actualiza la tabla del diseño y esta, en el mismo trabajo.

const css = readFileSync(fileURLToPath(new URL("../../src/ui/theme.css", import.meta.url)), "utf8");

const tokens = new Map(
  [...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((match) => [
    match[1] ?? "",
    match[2] ?? "",
  ]),
);

type Rgb = readonly [number, number, number];

function rgbOf(token: string): Rgb {
  const hex = tokens.get(token);
  if (!hex) throw new Error(`La hoja de tokens no define --${token} como color.`);
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as unknown as Rgb;
}

// Luminancia relativa y razón de contraste de WCAG 2.2.
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  // Truncado a dos decimales, como la tabla del diseño.
  return Math.floor(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

const AA_TEXT = 4.5;
const AA_UI = 3;
const EXEMPT = 0;

const SURFACES = ["bg", "surface-1", "surface-2", "surface-3"] as const;

// Elemento, razón sobre cada superficie, mínimo.
const onSurfaces: [string, [number, number, number, number], number][] = [
  ["text", [16.76, 15.44, 13.92, 12], AA_TEXT],
  ["text-2", [10.93, 10.07, 9.08, 7.83], AA_TEXT],
  ["text-3", [7.16, 6.59, 5.94, 5.12], AA_TEXT],
  ["accent", [12.24, 11.27, 10.16, 8.76], AA_TEXT],
  ["accent-strong", [14.29, 13.16, 11.86, 10.23], AA_TEXT],
  ["success", [10.36, 9.54, 8.6, 7.41], AA_TEXT],
  ["warning", [9.18, 8.46, 7.63, 6.57], AA_TEXT],
  ["danger", [8.44, 7.77, 7.01, 6.04], AA_TEXT],
  ["border-control", [5.98, 5.51, 4.97, 4.28], AA_UI],
  ["focus", [15.91, 14.66, 13.21, 11.39], AA_UI],
  // Sin mínimo: un control inactivo (1.4.3) y un borde decorativo.
  ["text-disabled", [3.71, 3.42, 3.08, 2.66], EXEMPT],
  ["border", [1.65, 1.52, 1.37, 1.18], EXEMPT],
];

// Lo de adelante, el fondo, la razón, el mínimo.
const pairs: [string, string, number, number][] = [
  ["bg", "text", 16.76, AA_TEXT], // botón principal
  ["on-accent", "accent", 11.44, AA_TEXT],
  ["on-accent", "accent-strong", 13.35, AA_TEXT],
  ["text", "accent-subtle", 12.37, AA_TEXT],
  ["accent", "accent-subtle", 9.03, AA_TEXT],
  ["success", "success-bg", 8.59, AA_TEXT],
  ["text", "success-bg", 13.91, AA_TEXT],
  ["warning", "warning-bg", 7.83, AA_TEXT],
  ["text", "warning-bg", 14.28, AA_TEXT],
  ["danger", "danger-bg", 7.49, AA_TEXT],
  ["text", "danger-bg", 14.86, AA_TEXT],
  ["text-2", "success-bg", 9.07, AA_TEXT],
  ["text-2", "warning-bg", 9.32, AA_TEXT],
  ["text-2", "danger-bg", 9.7, AA_TEXT],
  ["accent", "surface-3", 8.76, AA_UI], // barra de progreso sobre su pista
  // Paleta «papel», para correos y PDF.
  ["ink", "paper", 16.01, AA_TEXT],
  ["ink", "paper-2", 14.41, AA_TEXT],
  ["ink-2", "paper", 7.17, AA_TEXT],
  ["ink-2", "paper-2", 6.46, AA_TEXT],
  ["paper-accent", "paper", 8.2, AA_TEXT],
  ["paper-accent", "paper-2", 7.39, AA_TEXT],
  ["paper-success", "paper", 6.05, AA_TEXT],
  ["paper-success", "paper-2", 5.44, AA_TEXT],
  ["paper-warning", "paper", 5.97, AA_TEXT],
  ["paper-warning", "paper-2", 5.37, AA_TEXT],
  ["paper-danger", "paper", 5.75, AA_TEXT],
  ["paper-danger", "paper-2", 5.18, AA_TEXT],
];

describe("contraste de los tokens (diseño, secciones 3.3 y 3.4)", () => {
  it.each(onSurfaces)("%s sobre cada superficie", (element, expected, minimum) => {
    SURFACES.forEach((surface, index) => {
      const value = ratio(rgbOf(element), rgbOf(surface));
      expect(value, `${element} sobre ${surface} baja de ${minimum}:1`).toBeGreaterThanOrEqual(minimum);
      expect(value, `${element} sobre ${surface}: actualiza la tabla del diseño`).toBe(expected[index]);
    });
  });

  it.each(pairs)("%s sobre %s", (front, back, expected, minimum) => {
    const value = ratio(rgbOf(front), rgbOf(back));
    expect(value, `baja de ${minimum}:1`).toBeGreaterThanOrEqual(minimum);
    expect(value, "actualiza la tabla del diseño").toBe(expected);
  });

  // El velo es negro a 0.72 sobre la imagen. El peor caso es una imagen blanca.
  it.each([
    ["text", 8.22],
    ["text-2", 5.36],
  ])("%s sobre una imagen blanca con el velo a 0.72", (element, expected) => {
    const veiled = Math.round(255 * (1 - 0.72));
    const value = ratio(rgbOf(element), [veiled, veiled, veiled]);
    expect(value).toBeGreaterThanOrEqual(AA_TEXT);
    expect(value).toBe(expected);
  });

  it("text-3 es el texto más tenue: no hay un gris más claro que pase por texto", () => {
    const greys = ["text", "text-2", "text-3", "text-disabled"].map((token) => ratio(rgbOf(token), rgbOf("bg")));
    expect(greys).toEqual([...greys].sort((a, b) => b - a));
    expect(greys[3]).toBeLessThan(AA_TEXT);
  });
});
