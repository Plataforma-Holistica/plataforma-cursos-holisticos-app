import { longDate } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { portalStudentsPath } from "@/services/account/navigation";
import type { CourseStudentsValue, StudentsOrder } from "@/services/teachers/course-students-data";
import type { FunnelRow } from "@/ui/lesson-funnel";

// La tabla pura de PA-51 (T-408): qué se le pregunta a la base según la dirección, y qué se pinta con lo que contestó, ya en palabras. El componente no
// lee fechas ni cuentas. No decide nada que la base no haya decidido: sin resumen no hay cifra (se dice, nunca un cero), y uno viejo se dice con su fecha.
// Por alumno, el alias, lo terminado y el total.

const text = portal.students;

const COUNT = new Intl.NumberFormat("es-MX");
const count = (value: number): string => COUNT.format(value);

/** Lo que se ve de un corte: el día que cerró, porque el corte es la medianoche siguiente. */
const dayBefore = (cut: string): string => longDate(new Date(new Date(cut).getTime() - 1).toISOString());

/** Un valor de la dirección, si vino una sola vez: repetido no vale. */
const single = (value: string | string[] | undefined): string | undefined => (typeof value === "string" ? value : undefined);

/** El orden y la página que pide la dirección (`?orden=alias&pagina=2`). Lo que no se entiende es lo de siempre: por avance, la primera. */
export function studentsQuery(course: string, search: Readonly<Record<string, string | string[] | undefined>>): { course: string; order: StudentsOrder; page: number } {
  const page = single(search.pagina);
  return {
    course,
    order: single(search.orden) === "alias" ? "alias" : "progress",
    page: page !== undefined && /^[1-9][0-9]{0,4}$/.test(page) ? Number(page) : 1,
  };
}

export interface StudentRowView {
  key: string;
  alias: string;
  /** «2 de 3». */
  completed: string;
  value: number;
  max: number;
}

export interface StudentsView {
  title: string;
  /** «Cifras hasta el…»; nulo sin resumen. */
  figuresAt: string | null;
  /** Sin resumen todavía, o uno viejo. */
  notice: { tone: "warning" | "neutral"; text: string } | null;
  /** Hay resumen y nadie lo ha empezado. */
  nobody: boolean;
  tiles: { started: string | null; inProgress: string | null; finished: string | null };
  lessons: FunnelRow[];
  /** Contra qué se mide cada barra: quienes empezaron. */
  funnelMax: number;
  list: {
    /** «Lista hasta el…»; nulo si todavía no hay ninguna. */
    at: string | null;
    /** Por qué la lista está vacía; nulo si tiene a alguien. */
    pending: string | null;
    rows: StudentRowView[];
    /** El que se ve no enlaza. Cambiar el orden vuelve a la primera página. */
    orders: { key: StudentsOrder; label: string; href: string | null }[];
    /** «Página 2 de 3»; nulo con una sola. */
    page: string | null;
    previous: string | null;
    next: string | null;
  };
}

function notice(value: CourseStudentsValue): StudentsView["notice"] {
  if (value.figures === null) return { tone: "neutral", text: text.noSummary };
  return value.stale ? { tone: "warning", text: t(text.stale, { date: dayBefore(value.figures.cutAt) }) } : null;
}

export function studentsView(course: string, value: CourseStudentsValue, order: StudentsOrder): StudentsView {
  const { figures } = value;
  const path = (list: { order: StudentsOrder; page?: number }) => portalStudentsPath(course, list);
  const many = value.pages > 1;
  return {
    title: value.title,
    figuresAt: figures === null ? null : t(text.figuresAt, { date: dayBefore(figures.cutAt) }),
    notice: notice(value),
    // Con gente en la lista del lunes no se dice que nadie empezó, aunque la cifra de anoche diga 0 (una versión que retiró lo visto).
    nobody: figures !== null && figures.started === 0 && value.totalStudents === 0,
    tiles: {
      started: figures === null ? null : count(figures.started),
      inProgress: figures === null ? null : count(figures.inProgress),
      finished: figures === null ? null : count(figures.finished),
    },
    lessons: value.lessons.map((lesson, index) => ({
      key: `leccion-${index + 1}`,
      label: t(text.lessonLabel, { number: String(index + 1), title: lesson.title }),
      value: lesson.finished,
      amount: lesson.finished === null ? null : count(lesson.finished),
    })),
    funnelMax: figures?.started ?? 0,
    list: {
      at: value.listCutAt === null ? null : t(text.listAt, { date: dayBefore(value.listCutAt) }),
      pending: value.students.length === 0 ? text.listPending : null,
      rows: value.students.map((student, index) => ({
        key: `alumno-${index + 1}`,
        alias: student.alias,
        completed: t(text.completed, { completed: count(student.completed), total: count(student.total) }),
        value: student.completed,
        max: student.total,
      })),
      orders: (
        [
          ["progress", text.byProgress],
          ["alias", text.byAlias],
        ] as const
      ).map(([key, label]) => ({ key, label, href: key === order ? null : path({ order: key }) })),
      page: many ? t(text.page, { page: count(value.page), pages: count(value.pages) }) : null,
      previous: many && value.page > 1 ? path({ order, page: value.page - 1 }) : null,
      next: many && value.page < value.pages ? path({ order, page: value.page + 1 }) : null,
    },
  };
}
