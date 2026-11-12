import { ChevronDown, Play } from "lucide";
import Link from "next/link";
import type { ReactNode } from "react";

import { messages, plural, t } from "@/messages";
import { buttonLook } from "@/ui/button";
import { CourseArt } from "@/ui/course-cover";
import { cx } from "@/ui/cx";
import { Rosette } from "@/ui/flower";
import { Icon } from "@/ui/icon";

// El protagonista del inicio (T-616, solicitud 3; lo decidió el prototipo de la dirección, del carril A): «Continuar viendo»
// con lo más reciente, o «Para empezar» con el primero, y los demás en filas compactas debajo. Antes eran carruseles.
//
// - La portada va a 6 de 12 columnas, con el motivo grande de su práctica; si se está viendo, un botón de reproducir al
//   centro y la barra de avance de 3 px abajo. A la derecha, el título, el maestro, el avance y el botón.
// - Todo eso es un solo enlace, con el nombre de la tarjeta (lo que dice la barra va en él) y, al final, lo que dice el
//   botón, que se lee a la vista (WCAG 2.5.3). El botón es solo su aspecto (`buttonLook`): un botón dentro de un enlace no
//   vale. La portada lleva al mismo lugar con el ratón, pero queda fuera del teclado y del árbol de accesibilidad, para no
//   ser otra parada ni leerse dos veces.
// - Los demás van en la misma lista, en filas con la miniatura del motivo: tres a la vista y el resto en un `<details>`, para
//   que FL-13 se cumpla (todos los empezados siguen en el inicio, lo más reciente primero).
// - El antetítulo es el `<h2>` de la sección, y nombra la sección y la lista; la lista plegada lo lleva con lo que dice el
//   desplegable.
//
// Nada mide más que su columna: cada pieza del texto tiene `min-w-0` y las filas van a todo el ancho, para que un título
// largo se corte en vez de ensanchar la página (en el prototipo, la columna se ajustaba a su contenido y medía 430 px en 390).

const text = messages.browse.home;

/** Lo que pinta la portada: la práctica elige el motivo (por su orden en el catálogo), y el curso lo coloca. */
export interface FeaturePractice {
  name: string;
  tone: number;
  position?: number;
  slug?: string;
}

export interface FeatureRow {
  /** El curso (su slug): siembra la portada. */
  courseKey: string;
  href: string;
  /** El nombre del enlace, entero: el de la tarjeta de curso. */
  name: string;
  title: string;
  /** La línea de abajo: la lección en que va, o el maestro y el nivel. */
  line: string;
  practice: FeaturePractice | null;
  progress: { completed: number; total: number } | null;
}

export interface FeatureLead extends FeatureRow {
  teacherName: string;
  /** El avance en palabras, junto a la roseta. */
  progressLine: string | null;
  /** Lo que dice el botón. */
  action: string;
}

export interface FeatureProps {
  /** El `id` del antetítulo: nombra la sección y la lista. */
  id: string;
  heading: string;
  /** «Ver todo», si la sección lo lleva. */
  seeAll?: ReactNode;
  lead: FeatureLead;
  rows: readonly FeatureRow[];
}

/** Cuántas filas van a la vista; las demás, plegadas. */
const SHOWN_ROWS = 3;

const practiceKey = (practice: FeaturePractice | null) => practice?.position ?? practice?.slug ?? practice?.name ?? null;

function Bar({ progress }: { progress: { completed: number; total: number } }) {
  return (
    <progress
      value={Math.min(progress.completed, progress.total)}
      max={Math.max(progress.total, 1)}
      className="progress-bar progress-bar-thin absolute inset-x-0 bottom-0 w-full rounded-none"
    />
  );
}

function Row({ row }: { row: FeatureRow }) {
  return (
    <Link
      href={row.href}
      className="group flex w-full min-w-0 items-center gap-4 rounded-lg p-2 transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-1"
    >
      <span className="sr-only">{row.name}</span>
      <span aria-hidden="true" className="relative w-24 shrink-0 overflow-hidden rounded-md edge-light">
        <CourseArt practiceName={null} practiceKey={practiceKey(row.practice)} tone={row.practice?.tone ?? null} seed={row.courseKey} shape="wide" largeMotif />
        {row.progress !== null && <Bar progress={row.progress} />}
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-display text-body font-semibold text-text">{row.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-caption text-text-3">
          {row.progress !== null && <Rosette complete={row.progress.completed >= row.progress.total} className="size-4" />}
          <span className="truncate">{row.line}</span>
        </span>
      </span>
    </Link>
  );
}

export function Feature({ id, heading, seeAll, lead, rows }: FeatureProps) {
  const shown = rows.slice(0, SHOWN_ROWS);
  const rest = rows.slice(SHOWN_ROWS);
  return (
    <section aria-labelledby={id} className="flex flex-col gap-5 px-4 sm:px-8">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={id} className="eyebrow text-accent-muted">
          {heading}
        </h2>
        {seeAll}
      </div>
      <div className="grid min-w-0 gap-6 lg:grid-cols-12 lg:gap-12">
        <Link
          href={lead.href}
          tabIndex={-1}
          aria-hidden="true"
          className="group relative block overflow-hidden rounded-lg edge-light shadow-raised lg:col-span-6"
        >
          <CourseArt
            practiceName={lead.practice?.name ?? null}
            practiceKey={practiceKey(lead.practice)}
            tone={lead.practice?.tone ?? null}
            seed={lead.courseKey}
            shape="wide"
            largeMotif
            className="transition duration-(--duration-base) ease-standard group-hover:brightness-110"
          />
          {lead.progress !== null && (
            <>
              <span data-play className="absolute inset-0 flex items-center justify-center">
                <span className="relative flex size-16 items-center justify-center rounded-full text-text float-plane edge-light transition duration-(--duration-base) ease-standard motion-safe:group-hover:scale-105">
                  <Icon icon={Play} size={24} className="translate-x-0.5" />
                </span>
              </span>
              <Bar progress={lead.progress} />
            </>
          )}
        </Link>
        <div className="flex min-w-0 flex-col lg:col-span-6">
          <ul aria-labelledby={id} className="flex min-w-0 flex-col">
            <li className="min-w-0">
              <Link href={lead.href} className="group flex min-w-0 flex-col items-start gap-3 rounded-lg outline-offset-4">
                {/* El nombre lleva también lo que dice el botón, que se lee a la vista (WCAG 2.5.3): quien lo pide por voz dice eso. */}
                <span className="sr-only">{t(text.leadName, { name: lead.name, action: lead.action })}</span>
                <span aria-hidden="true" className="w-full font-display text-h1 text-balance wrap-break-word text-text display-narrow">
                  {lead.title}
                </span>
                <span aria-hidden="true" className="text-body-l text-text-2">
                  {lead.teacherName}
                </span>
                {lead.progress !== null && lead.progressLine !== null && (
                  <span aria-hidden="true" className="flex items-center gap-2 text-body-s text-text-3">
                    <Rosette complete={lead.progress.completed >= lead.progress.total} className="size-5" />
                    {lead.progressLine}
                  </span>
                )}
                <span aria-hidden="true" className={cx(buttonLook(), "mt-2 group-hover:bg-accent-strong")}>
                  {lead.action}
                </span>
              </Link>
            </li>
            {shown.map((row, index) => (
              <li key={row.courseKey} className={cx("min-w-0", index === 0 && "mt-8 border-t border-border pt-4")}>
                <Row row={row} />
              </li>
            ))}
          </ul>
          {rest.length > 0 && (
            <details className="group/mas">
              <summary
                id={`${id}-mas`}
                className="inline-flex min-h-touch cursor-pointer items-center gap-2 rounded-md px-2 text-body-s text-accent summary-plain hover:text-accent-strong"
              >
                {t(plural(rest.length, text.moreRows), { count: rest.length })}
                <Icon icon={ChevronDown} size={16} className="transition-transform duration-(--duration-fast) group-open/mas:rotate-180" />
              </summary>
              {/* Con nombre: el antetítulo y lo que dice el desplegable («Continuar viendo, ver los otros 2»). */}
              {/* Su nombre es el del desplegable, sin el antetítulo: uno que lo contuviera también respondería a «Continuar viendo». */}
              <ul aria-labelledby={`${id}-mas`} className="flex min-w-0 flex-col">
                {rest.map((row) => (
                  <li key={row.courseKey} className="min-w-0">
                    <Row row={row} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
