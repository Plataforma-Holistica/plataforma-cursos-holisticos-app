import { describe, expect, it } from "vitest";

import type { CatalogItem, CatalogLists, Practice } from "@/services/catalog/catalog";

import { catalogView } from "./rows";

// Lo que pinta la pantalla de las prácticas y los niveles (PA-67): qué botones ofrece cada
// fila. Donde la base contestaría `edge` no se ofrece: la primera activa no sube y la última
// no baja, contando solo las activas.

const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const level = (n: number, position: number, isActive = true): CatalogItem => ({ id: id(n), slug: `n${n}`, name: `Nivel ${n}`, position, isActive });
const practice = (n: number, position: number, coverTone: number, isActive = true): Practice => ({ ...level(n, position, isActive), coverTone });
const lists = (practices: Practice[], levels: CatalogItem[] = [], freshCode = true): CatalogLists => ({ freshCode, practices, levels });

describe("los botones de cada fila", () => {
  it("con desactivadas en medio, subir y bajar cuentan solo las activas", () => {
    const view = catalogView(lists([], [level(1, 1), level(2, 2, false), level(3, 3), level(4, 4, false)]));
    expect(view.levels.activeCount).toBe(2);
    expect(view.levels.rows.map((row) => [row.place, row.buttons.up !== null, row.buttons.down !== null])).toEqual([
      [1, false, true],
      [null, false, false],
      [2, true, false],
      [null, false, false],
    ]);
  });

  it("subir y bajar llevan la posición que se vio", () => {
    const [, second] = catalogView(lists([], [level(1, 4), level(2, 9)])).levels.rows;
    expect(second?.buttons.up).toBe(`up:${id(2)}:9`);
  });

  it("una activa: se renombra y se desactiva; una desactivada: solo se reactiva", () => {
    const [active, inactive] = catalogView(lists([], [level(1, 1), level(2, 2, false)])).levels.rows;
    expect(active?.buttons).toEqual({ up: null, down: null, rename: `rename:${id(1)}`, deactivate: `deactivate:${id(1)}`, reactivate: null });
    expect(inactive?.buttons).toEqual({ up: null, down: null, rename: null, deactivate: null, reactivate: `reactivate:${id(2)}` });
  });

  it("una sola activa entre desactivadas no sube ni baja", () => {
    const rows = catalogView(lists([], [level(1, 1, false), level(2, 2), level(3, 3, false)])).levels.rows;
    expect(rows.map((row) => [row.buttons.up, row.buttons.down])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("ninguna activa: nadie sube ni baja, y todas se reactivan", () => {
    const view = catalogView(lists([], [level(1, 1, false), level(2, 2, false)]));
    expect(view.levels.activeCount).toBe(0);
    expect(view.levels.rows.every((row) => row.buttons.reactivate !== null && row.place === null)).toBe(true);
  });

  it("vacía: sin filas", () => {
    expect(catalogView(lists([])).practices).toEqual({ rows: [], activeCount: 0 });
  });

  it("en el orden de su posición, aunque lleguen en otro", () => {
    expect(catalogView(lists([], [level(2, 7), level(1, 3)])).levels.rows.map((row) => row.name)).toEqual(["Nivel 1", "Nivel 2"]);
  });
});

describe("lo demás de una fila", () => {
  it("una práctica dice su tono en palabras; un nivel no tiene", () => {
    const view = catalogView(lists([practice(1, 1, 3), practice(2, 2, 8)], [level(3, 1)]));
    expect(view.practices.rows.map((row) => row.tone)).toEqual([
      { number: 3, name: "musgo" },
      { number: 8, name: "vino" },
    ]);
    expect(view.levels.rows[0]?.tone).toBeNull();
  });

  it("lo oculto de cada botón nombra la fila", () => {
    expect(catalogView(lists([], [level(1, 1)])).levels.rows[0]?.detail).toBe("«Nivel 1»");
  });

  it("los cambios se ofrecen solo si el código es reciente", () => {
    expect(catalogView(lists([], [], true)).canChange).toBe(true);
    expect(catalogView(lists([], [], false)).canChange).toBe(false);
  });
});
