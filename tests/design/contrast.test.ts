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

/** Un color con su opacidad sobre otro: lo que se ve. */
function mix(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((value, index) => Math.round(value * alpha + (bottom[index] ?? 0) * (1 - alpha))) as unknown as Rgb;
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
  // El oro apagado de los antetítulos sobre el fondo liso (T-616). Sobre una foto o un resplandor va el oro pleno.
  ["accent-muted", [7.75, 7.14, 6.44, 5.55], AA_TEXT],
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
  ["text-3", "accent-subtle", 5.28, AA_TEXT], // en la lección y el módulo elegidos (PA-43): su número, su etiqueta y «Ordenar»
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
  // El texto de una portada «arte» (T-616) sobre el tono más claro de su degradado, sin velo: el peor caso. La
  // práctica va arriba, donde cae el foco; el título va abajo, sobre un velo que solo lo oscurece más.
  ["text", "art-1", 5.35, AA_TEXT],
  ["text", "art-2", 4.93, AA_TEXT],
  ["text", "art-3", 4.93, AA_TEXT],
  ["text", "art-4", 5.53, AA_TEXT],
  ["text", "art-5", 5.64, AA_TEXT],
  ["text", "art-6", 5.2, AA_TEXT],
  ["text", "art-7", 5.6, AA_TEXT],
  ["text", "art-8", 5.39, AA_TEXT],
  // La caja del QR del segundo factor contra la página (T-616, 2b): su zona de silencio tiene que ser clara.
  ["qr-quiet", "bg", 18.94, AA_UI],
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

  // T-616, solicitud 3 (pedido del carril A): el conteo de una ficha de práctica del inicio va en `text-2` sobre su velo
  // (`from-bg/85` abajo), encima del tono de la práctica. El peor caso: el tono pleno debajo del velo, en cada tono.
  it.each(["art-1", "art-2", "art-3", "art-4", "art-5", "art-6", "art-7", "art-8"].map((tone, index) => [tone, [9.75, 9.67, 9.65, 9.82, 9.78, 9.72, 9.76, 9.79][index] ?? 0] as const))(
    "text-2 sobre el velo de una ficha de práctica de %s",
    (tone, expected) => {
      const value = ratio(rgbOf("text-2"), mix(rgbOf("bg"), 0.85, rgbOf(tone)));
      expect(value).toBeGreaterThanOrEqual(AA_TEXT);
      expect(value, "actualiza la tabla del diseño").toBe(expected);
    },
  );

  // El antetítulo de una cabecera va en el oro pleno sobre su resplandor (`--glow-header`): el peor caso es el centro del
  // resplandor, el `--glow` con su opacidad sobre el fondo.
  it("el antetítulo en oro sobre el centro del resplandor de la cabecera", () => {
    const glow = css.match(/--glow:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)\s*;/);
    if (glow === null) throw new Error("La hoja de tokens no define --glow como rgb con opacidad.");
    const [, r, g, b, alpha] = glow.map(Number) as [number, number, number, number, number];
    expect(css).toMatch(/--glow-header:\s*radial-gradient\([^;]*var\(--glow\)/);
    const value = ratio(rgbOf("accent"), mix([r, g, b], alpha, rgbOf("bg")));
    expect(value).toBeGreaterThanOrEqual(AA_TEXT);
    expect(value, "actualiza la tabla del diseño").toBe(9.78);
  });

  // T-616, 3b-3: en una cabecera sin foto (la cuenta, «Mis comentarios»), la entradilla va en `text-2` sobre la filigrana con
  // su resplandor. La filigrana es un trazo de un píxel en el tono del borde: el fondo que cuenta es el resplandor.
  it("la entradilla en text-2 sobre el centro del resplandor de una cabecera sin foto", () => {
    const glow = css.match(/--glow:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)\s*;/);
    if (glow === null) throw new Error("La hoja de tokens no define --glow como rgb con opacidad.");
    const [, r, g, b, alpha] = glow.map(Number) as [number, number, number, number, number];
    const value = ratio(rgbOf("text-2"), mix([r, g, b], alpha, rgbOf("bg")));
    expect(value).toBeGreaterThanOrEqual(AA_TEXT);
    expect(value, "actualiza la tabla del diseño").toBe(8.74);
  });

  // T-616, 3b-1 (decisión del carril A del 2026-11-12, y su revisión): en una cabecera con foto (`PageHeader`), todo su texto
  // (la entradilla en `text-2` y el antetítulo en el oro pleno) pasa 4.5 sobre el peor caso: un píxel blanco bajo el velo del
  // fondo, con el resplandor (`--glow-header`) encima, que aclara. El velo se lee de `page-header.tsx`: en la normal, lo más
  // tenue de su degradado (arriba, donde va el antetítulo); en la alta, el punto hasta donde llega a 75 % desde abajo.
  const header = readFileSync(fileURLToPath(new URL("../../src/ui/page-header.tsx", import.meta.url)), "utf8");
  const glow = css.match(/--glow:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)\s*;/)?.slice(1).map(Number) ?? [];
  /** Un píxel blanco con el velo y, encima, el centro del resplandor. */
  const worstUnder = (alpha: number): Rgb => {
    const [r = 0, g = 0, b = 0, glowAlpha = 0] = glow;
    return mix([r, g, b], glowAlpha, mix(rgbOf("bg"), alpha, [255, 255, 255]));
  };

  it.each([
    ["text-2", "normal", /bg-linear-to-b from-bg\/(\d+) to-bg/, 4.77],
    ["accent", "normal", /bg-linear-to-b from-bg\/(\d+) to-bg/, 5.34],
    ["text-2", "alta", /bg-linear-to-t from-bg via-bg\/(\d+) via-\d+% to-bg\/\d+/, 4.77],
    ["accent", "alta", /bg-linear-to-t from-bg via-bg\/(\d+) via-\d+% to-bg\/\d+/, 5.34],
  ] as const)("%s sobre una foto blanca con el velo de la cabecera %s y su resplandor", (element, _, veil, expected) => {
    expect(glow, "la hoja de tokens no define --glow como rgb con opacidad").toHaveLength(4);
    const alpha = Number(header.match(veil)?.[1]) / 100;
    expect(alpha, "el velo no está donde se busca").toBeGreaterThan(0);
    const value = ratio(rgbOf(element), worstUnder(alpha));
    expect(value).toBeGreaterThanOrEqual(AA_TEXT);
    expect(value, "actualiza la tabla del diseño").toBe(expected);
  });

  // En la alta, el texto empieza bajo su aire de arriba (64 px en el teléfono, 96 desde `sm`) y se apoya abajo. La cabecera
  // mide 224 px en el teléfono (más con un saludo de dos renglones: hasta unos 320) y 368 desde `sm`: el texto llega a lo más
  // al 80 % de su alto desde abajo ((320 − 64) / 320). Hasta ahí, el velo no baja de 75 %; arriba, la foto se ve.
  it("en la cabecera alta, el velo de 75 % llega hasta el 80 % desde abajo, donde termina el texto", () => {
    const position = Number(header.match(/bg-linear-to-t from-bg via-bg\/\d+ via-(\d+)%/)?.[1]);
    expect(position).toBeGreaterThanOrEqual(80);
    expect(header).toMatch(/hero \? "pt-16 [^"]*sm:pt-24/);
    expect(header).toMatch(/min-h-56 [^"]*sm:min-h-92/);
  });

  it("text-3 es el texto más tenue: no hay un gris más claro que pase por texto", () => {
    const greys = ["text", "text-2", "text-3", "text-disabled"].map((token) => ratio(rgbOf(token), rgbOf("bg")));
    expect(greys).toEqual([...greys].sort((a, b) => b - a));
    expect(greys[3]).toBeLessThan(AA_TEXT);
  });
});

// T-616, 3b-2: el reproductor en oro (decisión del carril A del 2026-11-12). La barra de avance es un elemento de interfaz: lo
// visto, en oro, se distingue de lo cargado y de la pista (3:1). Los dos son blanco translúcido, y se miden sobre el fondo del
// reproductor (negro); sobre un cuadro claro del video bajan (límite conocido, como el de cualquier control sobre video). Los
// menús de Mux van en `surface-2`: su texto y el oro del contorno y de la palomita ya están en la tabla de superficies.
describe("el reproductor en oro (T-616, 3b-2)", () => {
  const mux = css.slice(css.indexOf("@utility player-mux {"));
  const alphaOf = (variable: string) => Number(mux.match(new RegExp(`${variable}: rgb\\(255 255 255 \\/ ([\\d.]+)\\);`))?.[1]);
  const WHITE: Rgb = [255, 255, 255];
  // El fondo del reproductor se escribe corto (`#000`), y la tabla de tokens lee solo los de seis cifras.
  const PLAYER: Rgb = [0, 0, 0];
  it("el fondo del reproductor es negro", () => {
    expect(css).toMatch(/--player-bg: #000;/);
  });

  // Lo cargado va dentro de la pista (media-chrome lo inserta en `#track`), así que se ve con las dos capas encima del negro.
  // La revisión del diff de la 3b-2 encontró que medirlo solo daba 3.71 cuando lo que se ve daba 2.40.
  const TRACK = "--media-range-track-background";
  const BUFFERED = "--media-time-range-buffered-color";
  it("el avance en oro contra la pista sobre el negro del reproductor", () => {
    const track = alphaOf(TRACK);
    expect(track, `player-mux no define ${TRACK} como blanco con opacidad`).toBeGreaterThan(0);
    const value = ratio(rgbOf("accent"), mix(WHITE, track, PLAYER));
    expect(value).toBeGreaterThanOrEqual(AA_UI);
    expect(value, "actualiza la tabla del diseño").toBe(8.16);
  });

  it("el avance en oro contra lo cargado, que va sobre la pista, sobre el negro del reproductor", () => {
    const [track, buffered] = [alphaOf(TRACK), alphaOf(BUFFERED)];
    expect(buffered, `player-mux no define ${BUFFERED} como blanco con opacidad`).toBeGreaterThan(0);
    const value = ratio(rgbOf("accent"), mix(WHITE, buffered, mix(WHITE, track, PLAYER)));
    expect(value).toBeGreaterThanOrEqual(AA_UI);
    expect(value, "actualiza la tabla del diseño").toBe(3.71);
  });

  it("lo elegido en el menú de velocidad: el blanco fijo de Mux sobre surface-3", () => {
    const value = ratio(WHITE, rgbOf("surface-3"));
    expect(value).toBeGreaterThanOrEqual(AA_TEXT);
    expect(value, "actualiza la tabla del diseño").toBe(13.56);
  });

  it("el anillo de foco de un renglón del menú (el de Mux) sobre surface-2", () => {
    const value = ratio(mix([27, 127, 204], 0.9, rgbOf("surface-2")), rgbOf("surface-2"));
    expect(value).toBeGreaterThanOrEqual(AA_UI);
    expect(value, "actualiza la tabla del diseño").toBe(3.27);
  });

  it("el icono en on-accent donde el oro es fondo", () => {
    expect(ratio(rgbOf("on-accent"), rgbOf("accent"))).toBeGreaterThanOrEqual(AA_UI);
  });
});
