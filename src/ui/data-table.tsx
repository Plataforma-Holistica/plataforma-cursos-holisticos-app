import type { ReactNode } from "react";

import { cx } from "./cx";

// Tabla de datos (diseño, sección 5): `<table>` real con su título (`caption`), encabezados de columna
// y la primera celda de cada fila como encabezado de fila, que es también donde va su enlace (la fila
// completa no es un enlace). Las cifras van a la derecha y tabulares. Vacía, el encabezado sigue y el
// estado vacío va dentro. Las tablas de finanzas (PA-80, PA-81) no se vuelven tarjetas en el teléfono:
// se desplazan en horizontal con la primera columna fija (`scroll`), porque comparar columnas es su
// función. El orden por columna, los filtros y las filas que se abren llegan con quien los use.

export interface DataColumn {
  key: string;
  header: ReactNode;
  /** Cifras: a la derecha y tabulares. */
  numeric?: boolean;
}

export interface DataRow {
  key: string;
  cells: Record<string, ReactNode>;
}

export interface DataTableProps {
  caption: string;
  /** El título no se ve (lo dice un encabezado de la pantalla), pero la tabla lo conserva. */
  captionHidden?: boolean;
  columns: readonly DataColumn[];
  rows: readonly DataRow[];
  /** Lo que se dice dentro de la tabla cuando no hay filas. */
  empty: ReactNode;
  /** La fila de totales, al pie, con las mismas llaves que las columnas. */
  totals?: Record<string, ReactNode>;
  /** Se desplaza en horizontal con la primera columna fija (las de finanzas). */
  scroll?: boolean;
}

export function DataTable({ caption, captionHidden = false, columns, rows, empty, totals, scroll = false }: DataTableProps) {
  const sticky = scroll ? "sticky left-0 bg-surface-1" : undefined;
  const cellOf = (column: DataColumn, index: number, content: ReactNode, head: boolean) => {
    const classes = cx("px-3 py-2 align-top", column.numeric ? "text-right tabular-nums" : "text-left", index === 0 && sticky);
    if (index === 0 && head) {
      return (
        <th key={column.key} scope="row" className={cx(classes, "font-normal")}>
          {content}
        </th>
      );
    }
    return (
      <td key={column.key} className={classes}>
        {content}
      </td>
    );
  };

  return (
    <div className={cx("w-full rounded-md border border-border", scroll && "overflow-x-auto")}>
      <table className="w-full border-collapse text-body-s">
        <caption className={cx("px-3 py-2 text-left text-h3", captionHidden && "sr-only")}>{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={cx("px-3 py-2 text-label text-text-2 uppercase", column.numeric ? "text-right" : "text-left", index === 0 && sticky)}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-text-2">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-b-0">
                {columns.map((column, index) => cellOf(column, index, row.cells[column.key], true))}
              </tr>
            ))
          )}
        </tbody>
        {totals !== undefined && (
          <tfoot>
            <tr className="border-t border-border font-semibold">{columns.map((column, index) => cellOf(column, index, totals[column.key], true))}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
