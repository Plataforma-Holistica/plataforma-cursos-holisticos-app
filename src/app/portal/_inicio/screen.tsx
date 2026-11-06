import type { ReactNode } from "react";

import { portal } from "@/messages/es/portal";
import { ui } from "@/messages/es/ui";
import { ROUTES } from "@/services/account/navigation";
import { DataTable } from "@/ui/data-table";
import { InlineAlert } from "@/ui/inline-alert";
import { PeriodBars } from "@/ui/period-bars";
import { StatTile } from "@/ui/stat-tile";
import { TextLink } from "@/ui/text-link";

import type { CourseRowView, DashboardView, FirstStep } from "./outcomes";

// PA-41 · Panel (T-408), de solo lectura: cómo va el mes, por curso y los periodos anteriores. Lo pinta el inicio del portal después de la guarda y de
// sus avisos, con la vista ya en palabras (`outcomes.ts`). El maestro suspendido lo ve todo; la franja la pone el marco. Sin barras por día (decisión 3
// de Sergio del 2026-11-04) ni el porcentaje del bote.

const text = portal.home;

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

function FirstTime({ steps }: { steps: readonly FirstStep[] }) {
  return (
    <>
      <Section id="para-empezar" title={text.firstTime.title}>
        <ol className="flex max-w-reading list-decimal flex-col gap-3 pl-6">
          {steps.map((step) => (
            <li key={step.key}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {step.href === null ? <span>{step.label}</span> : <TextLink href={step.href}>{step.label}</TextLink>}
                {step.state !== null && <span className="text-body-s text-text-2">{step.state}</span>}
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <div className="flex max-w-reading flex-col items-start gap-3 rounded-md border border-border p-4">
        <p className="text-text-2">{text.noCourseYet}</p>
        <TextLink href={ROUTES.portalCourses}>{text.courses}</TextLink>
      </div>
    </>
  );
}

const COLUMNS = [
  { key: "course", header: text.courseColumns.course },
  { key: "fullLessons", header: text.courseColumns.fullLessons, numeric: true },
  { key: "halfLessons", header: text.courseColumns.halfLessons, numeric: true },
  { key: "students", header: text.courseColumns.students, numeric: true },
  { key: "progress", header: text.courseColumns.progress },
] as const;

function CourseTitle({ course }: { course: CourseRowView }) {
  return course.href === null ? <span>{course.title}</span> : <TextLink href={course.href}>{course.title}</TextLink>;
}

/** «Ver avance» (PA-51), con el curso en su nombre accesible, para que la lista de enlaces se entienda sola. */
function CourseProgress({ course }: { course: CourseRowView }) {
  if (course.progress === null) return null;
  return (
    <TextLink href={course.progress.href}>
      <span aria-hidden="true">{portal.courses.progress}</span>
      <span className="sr-only">{course.progress.name}</span>
    </TextLink>
  );
}

function Courses({ courses }: { courses: readonly CourseRowView[] }) {
  if (courses.length === 0) return <p className="text-text-2">{text.noCourses}</p>;
  const noData = (value: string | null) => value ?? ui.stat.noData;
  return (
    <>
      {/* Escritorio: la tabla. Teléfono: tarjetas, en el mismo orden. Sin corrida buena, cada cifra dice que no hay datos. */}
      <div className="hidden md:block">
        <DataTable
          caption={text.coursesCaption}
          captionHidden
          columns={COLUMNS}
          rows={courses.map((course) => ({
            key: course.key,
            cells: {
              course: <CourseTitle course={course} />,
              fullLessons: noData(course.fullLessons),
              halfLessons: noData(course.halfLessons),
              students: noData(course.students),
              progress: <CourseProgress course={course} />,
            },
          }))}
          empty={text.noCourses}
        />
      </div>
      <ul aria-label={text.coursesCaption} className="flex flex-col gap-4 md:hidden">
        {courses.map((course) => (
          <li key={course.key} className="flex flex-col gap-3 rounded-md border border-border p-4">
            <p className="font-semibold">
              <CourseTitle course={course} />
            </p>
            {course.progress !== null && (
              <p className="text-body-s">
                <CourseProgress course={course} />
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-body-s">
              <dt className="text-text-2">{text.courseColumns.fullLessons}</dt>
              <dd className="text-right tabular-nums">{noData(course.fullLessons)}</dd>
              <dt className="text-text-2">{text.courseColumns.halfLessons}</dt>
              <dd className="text-right tabular-nums">{noData(course.halfLessons)}</dd>
              <dt className="text-text-2">{text.courseColumns.students}</dt>
              <dd className="text-right tabular-nums">{noData(course.students)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export function DashboardPanel({ view }: { view: DashboardView }) {
  if (view.firstTime !== null) return <FirstTime steps={view.firstTime} />;
  const { tiles } = view;
  return (
    <>
      <section aria-labelledby="mes-titulo" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="mes-titulo" className="text-h2">
            {view.month}
          </h2>
          {view.updated !== null && <p className="text-body-s text-text-2">{view.updated}</p>}
        </div>
        {view.runNotice !== null && <InlineAlert tone={view.runNotice.tone}>{view.runNotice.text}</InlineAlert>}
        {/* Lo ganado primero, como en el diseño: en el teléfono, a todo el ancho; en escritorio, el primero de la fila. */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="col-span-2 lg:col-span-1">
            <StatTile label={text.figures.estimated} value={tiles.estimated.value} tag={text.estimatedTag} context={tiles.estimated.context ?? undefined} />
          </div>
          <StatTile label={text.figures.fullLessons} value={tiles.fullLessons} />
          <StatTile label={text.figures.halfLessons} value={tiles.halfLessons} />
          <StatTile label={text.figures.students} value={tiles.students} />
        </div>
        <p className="max-w-reading text-body-s text-text-2">{text.estimatedNote}</p>
        {view.noViews && <p className="text-text-2">{text.noViews}</p>}
      </section>

      <Section id="por-curso" title={text.coursesTitle}>
        <Courses courses={view.courses} />
      </Section>

      <Section id="periodos" title={text.seriesTitle}>
        {view.series.length > 0 && <p className="max-w-reading text-body-s text-text-2">{text.seriesNote}</p>}
        <PeriodBars id="periodos-anteriores" caption={text.seriesCaption} bars={view.series} empty={text.noSeries} />
      </Section>
    </>
  );
}

/** «No se supo»: los avisos del inicio siguen arriba, y el panel ofrece reintentar. */
export function DashboardUnavailable() {
  return (
    <InlineAlert tone="warning" action={<TextLink href={ROUTES.portal}>{text.retry}</TextLink>}>
      {text.unavailable}
    </InlineAlert>
  );
}
