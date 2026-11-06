import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { DataTable } from "./data-table";
import { barStep } from "./period-bars";

// Avance por lección (`LessonFunnel`, diseño, sección 5.10; PA-51; T-408): una fila por lección, en el orden del temario, con su título, una barra
// horizontal y cuántos alumnos la terminaron. No es un embudo de ventas: no hay porcentajes de caída. El ancho se mide contra lo que dé quien lo usa (en
// PA-51, cuántos empezaron el curso). Sin cifra, no se pinta una barra en cero: se dice que no hay datos.
//
// Como en `PeriodBars`, la gráfica es una ayuda y el lector de pantalla no la lee: los mismos datos van en una tabla, siempre presente para él y que «Ver
// como tabla» muestra a la vista, sin JavaScript. Si el foco llega a la tabla escondida, se muestra.

export interface FunnelRow {
  key: string;
  /** La lección, como se lee: «2. Soltar». */
  label: string;
  /** Cuántos la terminaron; nulo si no hay cifra. */
  value: number | null;
  /** La cifra ya escrita; nula si no hay. */
  amount: string | null;
}

export interface LessonFunnelProps {
  /** Para la casilla y la tabla: único en la pantalla. */
  id: string;
  /** El título de la tabla, para quien no ve la gráfica. */
  caption: string;
  rows: readonly FunnelRow[];
  /** Contra qué se mide el ancho: la barra llena. */
  max: number;
  /** Lo que se dice si no hay lecciones. */
  empty: string;
}

const text = ui.lessonFunnel;

// El ancho, en doceavos: cada clase escrita entera, para que Tailwind la encuentre. Lo que no es cero mide al menos un doceavo.
const WIDTHS = [
  "w-0", "w-1/12", "w-2/12", "w-3/12", "w-4/12", "w-5/12", "w-6/12", "w-7/12", "w-8/12", "w-9/12", "w-10/12", "w-11/12", "w-full",
] as const;

function Row({ row, max }: { row: FunnelRow; max: number }) {
  return (
    <li className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <span className="truncate text-body-s sm:w-1/3 sm:shrink-0">{row.label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        {/* El riel solo con cifra: sin ella no hay nada que medir. */}
        {row.value === null ? (
          <span className="flex-1" />
        ) : (
          <span className="flex h-3 flex-1 items-center rounded-sm bg-surface-1">
            <span className={cx("block h-full rounded-sm bg-text-2", WIDTHS[barStep(row.value, max)])} />
          </span>
        )}
        <span className="shrink-0 text-right text-caption text-text tabular-nums">{row.amount ?? ui.stat.noData}</span>
      </span>
    </li>
  );
}

const COLUMNS = [
  { key: "lesson", header: text.lesson },
  { key: "finished", header: text.finished, numeric: true },
] as const;

export function LessonFunnel({ id, caption, rows, max, empty }: LessonFunnelProps) {
  if (rows.length === 0) return <p className="text-text-2">{empty}</p>;
  const checkbox = `${id}-tabla`;
  return (
    <div className="group/funnel flex flex-col gap-3">
      <label htmlFor={checkbox} className="flex min-h-touch cursor-pointer items-center gap-3 self-start">
        <input id={checkbox} type="checkbox" className="size-5 shrink-0 cursor-pointer accent-accent" />
        <span className="text-body text-text">{text.showTable}</span>
      </label>
      <div aria-hidden="true">
        <ol className="flex flex-col gap-3">
          {rows.map((row) => (
            <Row key={row.key} row={row} max={max} />
          ))}
        </ol>
      </div>
      <div id={`${id}-datos`} className="sr-only group-has-checked/funnel:not-sr-only focus-within:not-sr-only">
        <DataTable
          caption={caption}
          columns={COLUMNS}
          rows={rows.map((row) => ({ key: row.key, cells: { lesson: row.label, finished: row.amount ?? ui.stat.noData } }))}
          empty={empty}
        />
      </div>
    </div>
  );
}
