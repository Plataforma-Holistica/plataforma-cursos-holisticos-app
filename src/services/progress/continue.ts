// «Continuar viendo» (RF-301, RF-307, FL-13; T-206), armado con las filas que la base devuelve:
// los cursos listados donde quien mira ya vio algo y le falta alguna lección vigente, el más
// reciente primero, cada uno con cuántas lleva terminadas y la lección sugerida (la regla del
// dominio). Es puro: las filas las lee `records.ts`.

import { courseProgress, suggestedLesson } from "@/domain/progress/progress";

/** Una fila: una lección vigente de un curso listado que quien mira empezó. */
export interface ContinueRowData {
  courseSlug: string;
  courseTitle: string;
  teacherName: string;
  /** La última vez que vio algo del curso. */
  lastWatchedAt: Date;
  /** La lección que vio al último, esté vigente o no. */
  lastLessonId: string | null;
  lessonId: string;
  lessonTitle: string;
  modulePosition: number;
  lessonPosition: number;
  completed: boolean;
}

export interface ContinueCourse {
  courseSlug: string;
  courseTitle: string;
  teacherName: string;
  completed: number;
  total: number;
  /** La sugerida, con su número en el temario («Lección 4 de 12»). */
  lesson: { id: string; title: string; number: number };
}

/** Cuántos cursos lleva la fila, como mucho. */
export const CONTINUE_LIMIT = 20;

export function continueWatchingOf(rows: readonly ContinueRowData[]): ContinueCourse[] {
  // Lo del curso es igual en todas sus filas: se toma de la primera que llega.
  const courses = new Map<string, { first: ContinueRowData; lessons: ContinueRowData[] }>();
  for (const row of rows) {
    const known = courses.get(row.courseSlug);
    if (known === undefined) courses.set(row.courseSlug, { first: row, lessons: [row] });
    else known.lessons.push(row);
  }

  const answer: { at: number; course: ContinueCourse }[] = [];
  for (const { first, lessons } of courses.values()) {
    const ordered = [...lessons].sort((a, b) => a.modulePosition - b.modulePosition || a.lessonPosition - b.lessonPosition);
    const syllabus = ordered.map((each) => ({ id: each.lessonId, completed: each.completed }));
    const suggested = suggestedLesson(syllabus, first.lastLessonId);
    const index = ordered.findIndex((each) => each.lessonId === suggested);
    const lesson = ordered[index];
    // Terminado: sale de la fila (FL-13 A3).
    if (lesson === undefined) continue;
    const { completed, total } = courseProgress(syllabus);
    answer.push({
      at: first.lastWatchedAt.getTime(),
      course: {
        courseSlug: first.courseSlug,
        courseTitle: first.courseTitle,
        teacherName: first.teacherName,
        completed,
        total,
        lesson: { id: lesson.lessonId, title: lesson.lessonTitle, number: index + 1 },
      },
    });
  }
  return answer
    .sort((a, b) => b.at - a.at)
    .slice(0, CONTINUE_LIMIT)
    .map((each) => each.course);
}
