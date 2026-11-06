import Link from "next/link";

import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { DataTable } from "./data-table";

// Barras por periodo (`PeriodBars`, diseño, sección 5.10; T-408): una barra por periodo con su monto encima. Los cerrados, en relleno; el que es un
// estimado (en curso o en cierre), solo con contorno punteado y la palabra «Estimado» debajo: la diferencia no depende del color. Sin cifra, no se pinta
// una barra en cero: se dice que no hay datos.
//
// La gráfica es una ayuda y el lector de pantalla no la lee: los mismos datos van en una tabla, siempre presente para él y que «Ver como tabla» muestra
// a la vista, sin JavaScript (una casilla, y la tabla se muestra con `:has(:checked)`). Los enlaces a cada liquidación son los de la tabla; los de las
// barras son solo para el ratón, fuera del orden del teclado. Si el foco llega a la tabla escondida, se muestra.

export interface PeriodBar {
  key: string;
  /** El periodo, como se lee: «Febrero de 2031». */
  label: string;
  /** El monto ya escrito; nulo si no hay cifra. */
  amount: string | null;
  /** El monto en centavos, para el alto de la barra; nulo si no hay cifra. */
  value: number | null;
  estimated: boolean;
  /** Una línea más bajo la etiqueta («En cierre»). */
  note?: string;
  /** Su liquidación, si la tiene. */
  href?: string;
}

export interface PeriodBarsProps {
  /** Para la casilla y la tabla: único en la pantalla. */
  id: string;
  /** El título de la tabla, para quien no ve la gráfica. */
  caption: string;
  bars: readonly PeriodBar[];
  /** Lo que se dice si no hay periodos. */
  empty: string;
}

const text = ui.periodBars;

// El alto, en doceavos de la gráfica: cada clase escrita entera, para que Tailwind la encuentre. Lo que no es cero mide al menos un doceavo.
const HEIGHTS = [
  "h-0", "h-1/12", "h-2/12", "h-3/12", "h-4/12", "h-5/12", "h-6/12", "h-7/12", "h-8/12", "h-9/12", "h-10/12", "h-11/12", "h-full",
] as const;

/** El alto de una barra entre 0 y 12, contra la más alta. */
export function barStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(12, Math.max(1, Math.round((value / max) * 12)));
}

function Bar({ bar, max }: { bar: PeriodBar; max: number }) {
  const shape =
    bar.value === null ? null : (
      <span
        className={cx(
          "block w-8 rounded-t-sm",
          HEIGHTS[barStep(bar.value, max)],
          bar.estimated ? "border-2 border-b-0 border-dashed border-text-2" : "bg-text-2",
        )}
      />
    );
  return (
    <li className="flex min-w-16 flex-1 flex-col items-center gap-1 text-caption">
      <span className="flex h-40 w-full flex-col items-center justify-end gap-1 border-b border-border">
        <span className="text-text tabular-nums">{bar.amount ?? ui.stat.noData}</span>
        <span className="flex w-full flex-1 items-end justify-center">
          {shape !== null && bar.href !== undefined ? (
            <Link href={bar.href} tabIndex={-1} className="flex h-full items-end">
              {shape}
            </Link>
          ) : (
            shape
          )}
        </span>
      </span>
      <span className="text-center text-text-2">{bar.label}</span>
      {bar.estimated && <span className="text-center text-warning">{text.estimated}</span>}
      {bar.note !== undefined && <span className="text-center text-text-2">{bar.note}</span>}
    </li>
  );
}

const COLUMNS = [
  { key: "period", header: text.period },
  { key: "amount", header: text.amount, numeric: true },
  { key: "kind", header: text.kind },
] as const;

export function PeriodBars({ id, caption, bars, empty }: PeriodBarsProps) {
  if (bars.length === 0) return <p className="text-text-2">{empty}</p>;
  const max = Math.max(0, ...bars.map((bar) => bar.value ?? 0));
  const checkbox = `${id}-tabla`;
  return (
    <div className="group/bars flex flex-col gap-3">
      <label htmlFor={checkbox} className="flex min-h-touch cursor-pointer items-center gap-3 self-start">
        <input id={checkbox} type="checkbox" className="size-5 shrink-0 cursor-pointer accent-accent" />
        <span className="text-body text-text">{text.showTable}</span>
      </label>
      <div aria-hidden="true" className="overflow-x-auto">
        <ol className="flex min-w-max gap-3 px-1 sm:min-w-0">
          {bars.map((bar) => (
            <Bar key={bar.key} bar={bar} max={max} />
          ))}
        </ol>
      </div>
      <div id={`${id}-datos`} className="sr-only group-has-checked/bars:not-sr-only focus-within:not-sr-only">
        <DataTable
          caption={caption}
          columns={COLUMNS}
          rows={bars.map((bar) => ({
            key: bar.key,
            cells: {
              period:
                bar.href === undefined ? (
                  bar.label
                ) : (
                  <Link href={bar.href} className="text-accent underline underline-offset-4 hover:text-accent-strong">
                    {bar.label}
                  </Link>
                ),
              amount: bar.amount ?? ui.stat.noData,
              kind: (
                <span className="flex flex-col">
                  <span>{bar.estimated ? text.estimated : text.final}</span>
                  {bar.note !== undefined && <span className="text-text-2">{bar.note}</span>}
                </span>
              ),
            },
          }))}
          empty={empty}
        />
      </div>
    </div>
  );
}
