import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { FailureCode } from "@/services/error-reporting/server";

// El avance de los alumnos de un curso (RF-612, RF-613, RN-15; PA-51; T-408). El maestro lee lo de un curso suyo, también suspendido: las tres cifras y
// lo terminado en cada lección, como estaban a la medianoche de la última noche, y la lista por alumno como estaba el lunes a las 00:00 (decisión 1 de
// Sergio del 2026-11-05). Por alumno, el alias de PA-51 (otro que el de PA-47), lo terminado y el total, y nada más. Lo decide la base; aquí se revisa
// la forma y no se le pregunta lo que no tiene forma.

/** Las tres cifras del curso, al corte de la noche. */
export interface CourseStudentsFigures {
  /** Lo empezaron: alguna lección vigente empezada. */
  started: number;
  /** Van a medio curso: empezado y sin terminar. */
  inProgress: number;
  /** Lo terminaron: todas las lecciones vigentes. */
  finished: number;
  /** El corte: la medianoche de la última noche que guardó el resumen. */
  cutAt: string;
}

export interface CourseStudentsLesson {
  title: string;
  /** Cuántos la terminaron; nulo antes de la primera noche. */
  finished: number | null;
}

export interface CourseStudent {
  alias: string;
  completed: number;
  total: number;
}

export interface CourseStudentsValue {
  title: string;
  /** Nulas antes de la primera noche. */
  figures: CourseStudentsFigures | null;
  /** Las lecciones vigentes, en el orden del temario. */
  lessons: CourseStudentsLesson[];
  /** Una página de la lista, de hasta 50. */
  students: CourseStudent[];
  page: number;
  pages: number;
  totalStudents: number;
  /** El lunes de la lista; nulo si todavía no se armó ninguna. */
  listCutAt: string | null;
  /** Sin resumen, o con uno de hace más de 26 horas. */
  stale: boolean;
}

export type CourseStudentsAnswer = { outcome: "ok"; value: CourseStudentsValue } | { outcome: "not_teacher" } | { outcome: "not_found" };

export type StudentsOrder = "progress" | "alias";

export interface StudentsQuery {
  course: string;
  order: StudentsOrder;
  page: number;
}

export interface CourseStudentsStore {
  read: (claims: VerifiedClaims, query: StudentsQuery) => Promise<CourseStudentsAnswer>;
}

export interface CourseStudentsDeps {
  store: CourseStudentsStore;
  report: (code: FailureCode) => Promise<void>;
}

/** Lo que contestó la base, o «no se supo». */
export type CourseStudentsRead = { kind: "ready"; value: CourseStudentsAnswer } | { kind: "unavailable" };

/** Un identificador de la base, en minúsculas: como lo escribe la dirección. */
const COURSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Más páginas que alumnos podría tener un curso: lo que pase de aquí es la última. */
const MAX_PAGE = 10_000;

const pageOf = (page: number): number => (Number.isFinite(page) ? Math.min(MAX_PAGE, Math.max(1, Math.trunc(page))) : 1);

export function createCourseStudents(deps: CourseStudentsDeps) {
  const { store, report } = deps;

  /** PA-51, con las claims que la guarda le dio a la página. Una caída o una respuesta sin forma es «no se supo», y se reporta. */
  async function courseStudents(claims: VerifiedClaims, query: StudentsQuery): Promise<CourseStudentsRead> {
    if (!COURSE_ID.test(query.course)) return { kind: "ready", value: { outcome: "not_found" } };
    try {
      return { kind: "ready", value: await store.read(claims, { ...query, page: pageOf(query.page) }) };
    } catch {
      await report("course_students_unavailable");
      return { kind: "unavailable" };
    }
  }

  return { courseStudents };
}
