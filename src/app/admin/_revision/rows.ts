import { longDate } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import type { LessonVideo, ReviewCourse, ReviewQueue } from "@/services/review/review";

import { reviewButton } from "./outcomes";

// Lo que la pantalla de revisión pinta, ya en palabras y con los valores de sus botones. Lo
// arma la página con lo que leyó: el navegador no decide qué se ofrece. Nada de aquí trae un
// identificador del proveedor de video: el video sale solo por la acción que lo pide.

const text = admin.review;

export interface LessonRow {
  id: string;
  title: string;
  /** Lo que dura, como en un reproductor: «5:56». */
  length: string;
  /** Se ofrece «Ver»: tiene video de Mux listo. */
  playable: boolean;
  /** Lo que se dice en vez de «Ver», o nulo si se puede ver. */
  status: string | null;
  /** Lo que va oculto después de «Ver», para quien no ve la fila. */
  detail: string;
  /** De qué curso y de qué maestro es: lo dice el reproductor, lejos de la cola. */
  context: string;
}

export interface ModuleRows {
  id: string;
  title: string;
  lessons: LessonRow[];
}

export interface CourseRow {
  id: string;
  title: string;
  practiceAndLevel: string;
  lessons: string;
  loaded: string;
  modules: ModuleRows[];
  /** Lo que la confirmación dice de más: que también se lista la ficha del maestro. */
  firstOfTeacher: string | null;
  buttons: { ask: string; confirm: string };
}

/** Los cursos de un maestro, del más antiguo al más nuevo. */
export interface TeacherGroup {
  name: string;
  courses: CourseRow[];
}

export interface ReviewView {
  /** El código de quien mira es reciente: se ofrece aprobar. */
  canChange: boolean;
  /**
   * La cola por maestro, cada uno en el orden de su curso más antiguo (lo pidió Sergio el
   * 2026-10-15: con muchos cursos, no se sabe de quién es qué). Se agrupa por el nombre
   * publicado: la base no le da el id del maestro a esta pantalla. Dos maestros que se
   * llamaran igual quedarían bajo el mismo nombre, que es cierto para los dos.
   */
  teachers: TeacherGroup[];
}

/** «5:56», «1:02:03»: lo que dura, como lo dice un reproductor. */
export function playLength(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) return "";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

const STATUS: Record<LessonVideo, string | null> = {
  playable: null,
  test: text.videos.test,
  processing: text.videos.processing,
  errored: text.videos.errored,
};

function courseRow(course: ReviewCourse): CourseRow {
  const modules: ModuleRows[] = [];
  for (const lesson of course.lessons) {
    // La base las da en orden; un módulo es la racha de lecciones con su mismo id (dos
    // módulos pueden llamarse igual).
    const last = modules.at(-1);
    const row: LessonRow = {
      id: lesson.lessonId,
      title: lesson.title,
      length: playLength(lesson.durationSeconds),
      playable: lesson.video === "playable",
      status: STATUS[lesson.video],
      detail: t(text.watchOf, { title: lesson.title }),
      context: t(text.watchingContext, { course: course.title, teacher: course.teacherName }),
    };
    if (last !== undefined && last.id === lesson.moduleId) last.lessons.push(row);
    else modules.push({ id: lesson.moduleId, title: lesson.module, lessons: [row] });
  }
  return {
    id: course.courseId,
    title: course.title,
    practiceAndLevel: t(text.practiceAndLevel, { practice: course.practice ?? text.unset, level: course.level ?? text.unset }),
    lessons: t(plural(course.lessonCount, text.lessons), { count: String(course.lessonCount), duration: playLength(course.totalDurationSeconds) }),
    loaded: t(text.loaded, { date: longDate(course.loadedAt) }),
    modules,
    firstOfTeacher: course.teacherListed ? null : t(text.confirmFirst, { teacher: course.teacherName }),
    buttons: { ask: reviewButton.ask(course.courseId), confirm: reviewButton.confirm(course.courseId) },
  };
}

/** El nombre con que se agrupa: el mismo a la vista, aunque llegue escrito distinto en Unicode o con espacios de más. */
const groupKey = (name: string) => name.normalize("NFC").trim().replace(/\s+/g, " ");

export function reviewView(queue: ReviewQueue): ReviewView {
  // Del más antiguo al más nuevo, aquí mismo: el orden no se le deja a la base. El primero de
  // cada maestro fija su lugar.
  const sorted = [...queue.courses].sort((a, b) => Date.parse(a.loadedAt) - Date.parse(b.loadedAt) || a.courseId.localeCompare(b.courseId));
  const teachers: (TeacherGroup & { key: string })[] = [];
  for (const course of sorted) {
    const key = groupKey(course.teacherName);
    const group = teachers.find((each) => each.key === key);
    if (group === undefined) teachers.push({ key, name: key, courses: [courseRow(course)] });
    else group.courses.push(courseRow(course));
  }
  return { canChange: queue.freshCode, teachers: teachers.map(({ name, courses }) => ({ name, courses })) };
}
