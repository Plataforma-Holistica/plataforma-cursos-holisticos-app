import { describe, expect, it } from "vitest";

import { layOutRows, SHORT_ROW } from "./rows";

// Las prácticas con pocos cursos, lado a lado (T-614, parte 4; decisión de Sergio del 2026-11-05): en
// computadora, dos seguidas que tengan a lo más `SHORT_ROW` cursos comparten el renglón. Cada una conserva su
// bloque, y el orden de PA-67 no cambia: solo se juntan dos que ya iban juntas.

const row = (slug: string, count: number) => ({ slug, count });
const size = (each: { count: number }) => each.count;
const slugs = (laid: ReturnType<typeof layOutRows<{ slug: string; count: number }>>) =>
  laid.map((line) => (line.kind === "pair" ? `${line.rows[0].slug}+${line.rows[1].slug}` : line.row.slug));

describe("layOutRows", () => {
  it("una fila corta tiene uno o dos cursos", () => {
    expect(SHORT_ROW).toBe(2);
  });

  it("sin filas, nada", () => {
    expect(layOutRows([], size)).toEqual([]);
  });

  it("dos cortas seguidas comparten el renglón", () => {
    expect(slugs(layOutRows([row("a", 1), row("b", 2)], size))).toEqual(["a+b"]);
  });

  it("una larga va sola, y no se salta para juntar a las de los lados", () => {
    expect(slugs(layOutRows([row("a", 1), row("b", 3), row("c", 2)], size))).toEqual(["a", "b", "c"]);
  });

  it("tres cortas seguidas: un par y la tercera sola, en el mismo orden", () => {
    expect(slugs(layOutRows([row("a", 2), row("b", 1), row("c", 1)], size))).toEqual(["a+b", "c"]);
  });

  it("el orden de las filas no cambia nunca", () => {
    const rows = [row("a", 5), row("b", 1), row("c", 1), row("d", 4), row("e", 2), row("f", 1), row("g", 1)];
    expect(slugs(layOutRows(rows, size)).join("+").split("+")).toEqual(rows.map((each) => each.slug));
  });
});
