import { Fragment, type ReactNode } from "react";

import { layOutRows } from "./rows";

// Las filas por práctica del inicio (PA-20) y de explorar sin filtro (PA-21), con las cortas lado a lado en
// computadora (`layOutRows`; T-614, parte 4). Cada fila la pinta quien llama, con su carrusel: aquí solo se
// decide qué comparte renglón. En el teléfono todo sigue en una columna.

export function PracticeRows<T extends { slug: string; courses: readonly unknown[] }>({
  rows,
  render,
}: {
  rows: readonly T[];
  render: (row: T) => ReactNode;
}) {
  return layOutRows(rows, (row) => row.courses.length).map((line) =>
    line.kind === "pair" ? (
      <div key={`${line.rows[0].slug}+${line.rows[1].slug}`} className="grid gap-10 lg:grid-cols-2 lg:gap-0">
        {render(line.rows[0])}
        {render(line.rows[1])}
      </div>
    ) : (
      <Fragment key={line.row.slug}>{render(line.row)}</Fragment>
    ),
  );
}
