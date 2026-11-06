// Las prácticas con pocos cursos, lado a lado (T-614, parte 4; decisión de Sergio del 2026-11-05): en el
// inicio (PA-20) y en explorar sin filtro (PA-21), cada práctica conserva su bloque con su título y su «Ver
// todo», pero dos seguidas con a lo más `SHORT_ROW` cursos comparten el renglón en computadora. Solo se
// juntan dos que ya iban juntas: el orden de PA-67 no cambia. Es puro.

/** Cuántos cursos tiene, a lo más, una fila corta. */
export const SHORT_ROW = 2;

export type RowLine<T> = { kind: "single"; row: T } | { kind: "pair"; rows: readonly [T, T] };

export function layOutRows<T>(rows: readonly T[], size: (row: T) => number): RowLine<T>[] {
  const lines: RowLine<T>[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as T;
    const next = rows[index + 1];
    if (next !== undefined && size(row) <= SHORT_ROW && size(next) <= SHORT_ROW) {
      lines.push({ kind: "pair", rows: [row, next] });
      index += 1;
    } else {
      lines.push({ kind: "single", row });
    }
  }
  return lines;
}
