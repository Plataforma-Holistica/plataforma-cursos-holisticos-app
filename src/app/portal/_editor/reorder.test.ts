import { describe, expect, it } from "vitest";

import { arranged, dropButton, stepTo } from "./reorder";

// Arrastrar en la estructura del editor (PA-43; tercera solicitud de T-402): con el teclado la fila se
// mueve dentro de su lista; con el ratón, a cualquier lugar. Lo que se manda al soltar es un botón con
// lo que se vio, el mismo camino que «Subir» y «Bajar».

const M1 = "d0000000-0000-4000-8000-000000000001";
const M2 = "d0000000-0000-4000-8000-000000000002";
const L1 = "e0000000-0000-4000-8000-000000000001";
const L2 = "e0000000-0000-4000-8000-000000000002";
const L3 = "e0000000-0000-4000-8000-000000000003";

const modules = [
  { id: M1, lessons: [{ id: L1 }, { id: L2 }] },
  { id: M2, lessons: [{ id: L3 }] },
];

describe("stepTo", () => {
  it("las flechas mueven un lugar, sin salirse de la lista", () => {
    expect(stepTo(3, 2, "up")).toBe(1);
    expect(stepTo(3, 2, "down")).toBe(3);
    expect(stepTo(3, 1, "up")).toBe(1);
    expect(stepTo(3, 3, "down")).toBe(3);
  });
});

describe("arranged", () => {
  it("pinta la lista con la fila en el lugar que lleva", () => {
    expect(arranged(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(arranged(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(arranged(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("dropButton", () => {
  it("un módulo sobre otro toma su lugar", () => {
    expect(dropButton(modules, { kind: "module", id: M2 }, { kind: "module", id: M1 })).toBe(`module-to:${M2}:2:1`);
    expect(dropButton(modules, { kind: "module", id: M1 }, { kind: "module", id: M2 })).toBe(`module-to:${M1}:1:2`);
  });

  it("una lección sobre otra de su módulo toma su lugar", () => {
    expect(dropButton(modules, { kind: "lesson", id: L2 }, { kind: "lesson", id: L1 })).toBe(`lesson-to:${L2}:${M1}:2:${M1}:1`);
  });

  it("una lección sobre una de otro módulo entra en su lugar; sobre el módulo, al final", () => {
    expect(dropButton(modules, { kind: "lesson", id: L1 }, { kind: "lesson", id: L3 })).toBe(`lesson-to:${L1}:${M1}:1:${M2}:1`);
    expect(dropButton(modules, { kind: "lesson", id: L1 }, { kind: "module", id: M2 })).toBe(`lesson-to:${L1}:${M1}:1:${M2}:2`);
  });

  it("soltar donde ya estaba, o un módulo sobre una lección, no manda nada", () => {
    expect(dropButton(modules, { kind: "module", id: M1 }, { kind: "module", id: M1 })).toBeNull();
    expect(dropButton(modules, { kind: "lesson", id: L1 }, { kind: "lesson", id: L1 })).toBeNull();
    expect(dropButton(modules, { kind: "module", id: M1 }, { kind: "lesson", id: L3 })).toBeNull();
    // Sobre su propio módulo, ya está en él.
    expect(dropButton(modules, { kind: "lesson", id: L1 }, { kind: "module", id: M1 })).toBeNull();
  });

  it("lo que no está en la estructura no manda nada", () => {
    expect(dropButton(modules, { kind: "lesson", id: "x" }, { kind: "lesson", id: L1 })).toBeNull();
    expect(dropButton(modules, { kind: "module", id: M1 }, { kind: "module", id: "x" })).toBeNull();
  });
});
