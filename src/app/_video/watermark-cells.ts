// Dónde va la marca de agua y cada cuánto se mueve (diseño, sección 5.4; RF-305). Una rejilla
// de 3 × 3 sobre el área segura del video (del 10 % al 68 % del alto y del 4 % al 96 % del
// ancho), numerada de izquierda a derecha y de arriba abajo. Usa las ocho celdas del borde,
// nunca la central: ahí suele estar la cara de quien enseña. Las posiciones de cada celda son
// clases de `src/ui/theme.css` (`watermark-cell-0` a `watermark-cell-8`).

/** La celda del centro de la rejilla, que la marca no usa. */
export const CENTER_CELL = 4;

/** Las ocho celdas del borde. */
export const WATERMARK_CELLS = [0, 1, 2, 3, 5, 6, 7, 8] as const;
export type WatermarkCell = (typeof WATERMARK_CELLS)[number];

/** Cada cuánto cambia de celda (decisión de Sergio del 2026-10-15). Es del diseño, no del negocio. */
export const WATERMARK_INTERVAL_MS = 30_000;
/** Lo que dura el desvanecido al cambiar de celda: `duration-slow` (diseño, sección 3.9). */
export const WATERMARK_FADE_MS = 320;

/**
 * La siguiente celda: al azar entre las del borde, nunca la misma que la actual. `random`
 * devuelve un número en [0, 1); uno fuera de rango no la saca de las celdas.
 */
export function nextWatermarkCell(current: WatermarkCell | null, random: () => number): WatermarkCell {
  const options = WATERMARK_CELLS.filter((cell) => cell !== current);
  const value = random();
  const index = Number.isFinite(value) ? Math.min(Math.max(Math.floor(value * options.length), 0), options.length - 1) : 0;
  return options[index] ?? WATERMARK_CELLS[0];
}
