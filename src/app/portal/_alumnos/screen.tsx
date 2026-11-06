import type { ReactNode } from "react";

import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { DataTable } from "@/ui/data-table";
import { InlineAlert } from "@/ui/inline-alert";
import { LessonFunnel } from "@/ui/lesson-funnel";
import { ProgressBar } from "@/ui/progress-bar";
import { StatTile } from "@/ui/stat-tile";
import { TextLink } from "@/ui/text-link";

import { PortalFrame } from "../_lib/frame";

import type { StudentRowView, StudentsView } from "./rows";

// PA-51 · Avance de alumnos (T-408), de solo lectura: las tres cifras, el avance por lección y la lista con el alias de esta pantalla. Lo pinta el comodín
// del portal después de la guarda, con la vista ya en palabras (`rows.ts`). Ninguna acción sobre un alumno: ni se le escribe ni se le marca. El orden y las
// páginas son enlaces, y funcionan sin JavaScript. El maestro suspendido lo ve todo; la franja la pone el marco.

const text = portal.students;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-titulo`} className="flex flex-col gap-4">
      <h2 id={`${id}-titulo`} className="text-h2">
        {title}
      </h2>
      {children}
    </section>
  );
}

const COLUMNS = [
  { key: "student", header: text.columns.student },
  { key: "completed", header: text.columns.completed, numeric: true },
  { key: "progress", header: text.columns.progress },
] as const;

const bar = (row: StudentRowView, size: "thin" | "medium") => (
  <ProgressBar value={row.value} max={row.max} label={t(text.progressLabel, { alias: row.alias })} text={row.completed} size={size} />
);

function List({ list }: { list: StudentsView["list"] }) {
  return (
    <>
      {list.at !== null && <p className="text-body-s text-text-2">{list.at}</p>}
      {list.pending !== null ? (
        <p className="text-text-2">{list.pending}</p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-body-s text-text-2">{text.orderLabel}</span>
            {list.orders.map((order) =>
              order.href === null ? (
                <span key={order.key} aria-current="true" className="font-semibold">
                  {order.label}
                </span>
              ) : (
                <TextLink key={order.key} href={order.href}>
                  {order.label}
                </TextLink>
              ),
            )}
          </p>
          {/* Escritorio: la tabla. Teléfono: filas compactas, en el mismo orden. */}
          <div className="hidden md:block">
            <DataTable
              caption={text.listCaption}
              captionHidden
              columns={COLUMNS}
              rows={list.rows.map((row) => ({
                key: row.key,
                cells: { student: row.alias, completed: row.completed, progress: bar(row, "medium") },
              }))}
              empty={text.listPending}
            />
          </div>
          <ul aria-label={text.listCaption} className="flex flex-col gap-3 md:hidden">
            {list.rows.map((row) => (
              <li key={row.key} className="flex flex-col gap-1 border-b border-border pb-3">
                <p className="font-semibold">{row.alias}</p>
                {bar(row, "thin")}
              </li>
            ))}
          </ul>
          {list.page !== null && (
            <nav aria-label={text.pagination} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {list.previous !== null && <TextLink href={list.previous}>{text.previous}</TextLink>}
              <span className="text-body-s text-text-2">{list.page}</span>
              {list.next !== null && <TextLink href={list.next}>{text.next}</TextLink>}
            </nav>
          )}
        </>
      )}
    </>
  );
}

export function StudentsScreen({ view, readOnly }: { view: StudentsView; readOnly: boolean }) {
  const { tiles } = view;
  return (
    <PortalFrame current={ROUTES.portalCourses} readOnly={readOnly}>
      <div className="flex flex-col gap-3">
        <BackLink href={ROUTES.portalCourses}>{text.back}</BackLink>
        <p className="text-body-s text-text-2">{text.eyebrow}</p>
        <h1 className="text-h1">{view.title}</h1>
        <p className="max-w-reading text-text-2">{text.aliasNote}</p>
      </div>

      <Section id="como-va" title={text.figuresTitle}>
        {view.figuresAt !== null && <p className="text-body-s text-text-2">{view.figuresAt}</p>}
        {view.notice !== null && <InlineAlert tone={view.notice.tone}>{view.notice.text}</InlineAlert>}
        {view.nobody ? (
          <p className="text-text-2">{text.nobody}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label={text.figures.started} value={tiles.started} />
            <StatTile label={text.figures.inProgress} value={tiles.inProgress} />
            <StatTile label={text.figures.finished} value={tiles.finished} />
          </div>
        )}
      </Section>

      {!view.nobody && (
        <>
          <Section id="por-leccion" title={text.lessonsTitle}>
            <p className="max-w-reading text-body-s text-text-2">{text.lessonsNote}</p>
            <LessonFunnel id="avance-por-leccion" caption={text.lessonsCaption} rows={view.lessons} max={view.funnelMax} empty={text.noLessons} />
          </Section>

          <Section id="alumnos" title={text.listTitle}>
            <List list={view.list} />
          </Section>
        </>
      )}
    </PortalFrame>
  );
}
