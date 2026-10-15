import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CENTER_CELL, nextWatermarkCell, WATERMARK_CELLS } from "./watermark-cells";

// Dónde va la marca de agua (diseño, sección 5.4): las ocho celdas del borde de una rejilla de
// 3 × 3 sobre el área segura, nunca la central, donde suele estar la cara de quien enseña.

describe("las celdas de la marca de agua", () => {
  it("son las ocho del borde de la rejilla, sin la central", () => {
    expect([...WATERMARK_CELLS].sort()).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(WATERMARK_CELLS).not.toContain(CENTER_CELL);
    expect(CENTER_CELL).toBe(4);
  });

  it("la primera sale al azar de las ocho", () => {
    expect(nextWatermarkCell(null, () => 0)).toBe(WATERMARK_CELLS[0]);
    expect(nextWatermarkCell(null, () => 0.999_999)).toBe(WATERMARK_CELLS[7]);
  });

  it("la siguiente nunca es la misma, ni la central, y puede ser cualquiera de las otras siete", () => {
    fc.assert(
      fc.property(fc.constantFrom(...WATERMARK_CELLS), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (current, random) => {
        const next = nextWatermarkCell(current, () => random);
        expect(next).not.toBe(current);
        expect(WATERMARK_CELLS).toContain(next);
      }),
    );
    for (const current of WATERMARK_CELLS) {
      const reached = new Set(Array.from({ length: 7 }, (_, index) => nextWatermarkCell(current, () => index / 7)));
      expect(reached.size).toBe(7);
    }
  });

  it("un azar fuera de rango no la saca de las celdas, ni la deja en la misma", () => {
    for (const random of [-1, 1, 7, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const current of WATERMARK_CELLS) {
        const next = nextWatermarkCell(current, () => random);
        expect(WATERMARK_CELLS).toContain(next);
        expect(next).not.toBe(current);
      }
      expect(WATERMARK_CELLS).toContain(nextWatermarkCell(null, () => random));
    }
  });
});
