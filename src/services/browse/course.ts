// La ficha de un curso (PA-02; RF-302, RF-307; T-210), armada con las filas que lee
// `records.ts`: el curso, su temario por módulos y, para quien mira con sesión, en qué va.
// Es puro.

import { courseProgress, lessonState, suggestedLesson, type LessonProgressFacts, type LessonState } from "@/domain/progress/progress";

import type { ShelfCourse } from "./shelf";

/** Una lección vigente del curso, con su módulo vigente. */
export interface CourseLessonRow {
  moduleId: string;
  moduleTitle: string;
  modulePosition: number;
  lessonId: string;
  lessonTitle: string;
  lessonPosition: number;
  durationSeconds: number;
}

/** Un recurso vigente del curso (T-404): lo que cualquiera ve. La ruta del archivo nunca sale de la puerta de medios. */
export interface CourseResourceRow {
  id: string;
  title: string;
  kind: "pdf" | "doc" | "audio";
  sizeBytes: number;
}

export interface CourseDetail {
  course: ShelfCourse;
  teacher: { slug: string; name: string; bio: string | null } | null;
  modules: { id: string; title: string; lessons: { id: string; title: string; number: number; durationSeconds: number }[] }[];
  /** La primera lección del temario: a donde lleva «Empezar». */
  firstLesson: { id: string; title: string };
}

/** La ficha, o nula si el curso no tiene lecciones vigentes: no se ofrece algo que no se puede ver. */
export function courseDetailOf(
  course: ShelfCourse,
  teacher: CourseDetail["teacher"],
  rows: readonly CourseLessonRow[],
): CourseDetail | null {
  const ordered = [...rows].sort((a, b) => a.modulePosition - b.modulePosition || a.lessonPosition - b.lessonPosition);
  const first = ordered[0];
  if (first === undefined) return null;
  const modules: CourseDetail["modules"] = [];
  for (const [index, row] of ordered.entries()) {
    let group = modules.at(-1);
    if (group === undefined || group.id !== row.moduleId) {
      group = { id: row.moduleId, title: row.moduleTitle, lessons: [] };
      modules.push(group);
    }
    group.lessons.push({ id: row.lessonId, title: row.lessonTitle, number: index + 1, durationSeconds: row.durationSeconds });
  }
  return { course, teacher, modules, firstLesson: { id: first.lessonId, title: first.lessonTitle } };
}

/** Lo guardado de una lección para quien mira, y cuándo vio algo de ella por última vez. */
export interface MyLessonProgress {
  lessonId: string;
  facts: LessonProgressFacts;
  lastWatchedAt: Date;
}

export interface CourseStanding {
  states: ReadonlyMap<string, LessonState>;
  completed: number;
  total: number;
  /** Si vio algo de alguna lección vigente. */
  started: boolean;
  finished: boolean;
  /** La lección sugerida (FL-13), con su número; nula si terminó todas. */
  suggested: { id: string; number: number } | null;
}

/** En qué va quien mira, con la regla de la lección sugerida del dominio. */
export function courseStandingOf(detail: CourseDetail, progress: readonly MyLessonProgress[]): CourseStanding {
  const byLesson = new Map(progress.map((each) => [each.lessonId, each]));
  const syllabus = detail.modules.flatMap((group) => group.lessons);
  const states = new Map(syllabus.map((lesson) => [lesson.id, lessonState(byLesson.get(lesson.id)?.facts ?? null)]));
  const lastWatched = [...progress].sort((a, b) => b.lastWatchedAt.getTime() - a.lastWatchedAt.getTime() || a.lessonId.localeCompare(b.lessonId))[0];
  const marks = syllabus.map((lesson) => ({ id: lesson.id, completed: states.get(lesson.id) === "completed" }));
  const suggestedId = suggestedLesson(marks, lastWatched?.lessonId ?? null);
  const suggested = syllabus.find((lesson) => lesson.id === suggestedId);
  const { completed, total, finished } = courseProgress(marks);
  return {
    states,
    completed,
    total,
    started: syllabus.some((lesson) => states.get(lesson.id) !== "not_started"),
    finished,
    suggested: suggested === undefined ? null : { id: suggested.id, number: suggested.number },
  };
}
