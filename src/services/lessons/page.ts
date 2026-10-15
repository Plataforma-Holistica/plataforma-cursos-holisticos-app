// Lo que pinta la página de una lección (PA-22, T-203), armado con las filas que la base
// devuelve: el curso, su temario por módulos, la lección que se pidió y la que sigue. Es puro:
// las filas las lee `records.ts`. Nunca trae nada del video: el reproductor lo pide aparte
// (RF-305).

/** Una fila: una lección vigente de un curso listado, con su módulo y su curso. */
export interface LessonRowData {
  courseSlug: string;
  courseTitle: string;
  courseSummary: string | null;
  teacherName: string;
  moduleId: string;
  moduleTitle: string;
  modulePosition: number;
  lessonId: string;
  lessonTitle: string;
  lessonPosition: number;
  durationSeconds: number;
}

export interface LessonEntry {
  id: string;
  title: string;
  /** Su número en el curso entero, desde 1. */
  number: number;
  durationSeconds: number;
  current: boolean;
}

export interface LessonPage {
  course: { slug: string; title: string; summary: string | null; teacherName: string };
  lesson: { id: string; title: string; number: number; durationSeconds: number; moduleTitle: string };
  modules: { id: string; title: string; lessons: LessonEntry[] }[];
  /** La siguiente del temario, o nula si es la última. */
  next: { id: string; title: string } | null;
  lessonCount: number;
}

/**
 * La página, o nula si la lección no está entre las filas: no existe, no está vigente, o es de
 * otro curso. Las tres se ven igual (PA-19).
 */
export function lessonPageOf(rows: readonly LessonRowData[], lessonId: string): LessonPage | null {
  const ordered = [...rows].sort((a, b) => a.modulePosition - b.modulePosition || a.lessonPosition - b.lessonPosition);
  const index = ordered.findIndex((row) => row.lessonId === lessonId);
  const current = ordered[index];
  if (current === undefined) return null;

  const modules: LessonPage["modules"] = [];
  for (const [position, row] of ordered.entries()) {
    let group = modules.at(-1);
    if (group === undefined || group.id !== row.moduleId) {
      group = { id: row.moduleId, title: row.moduleTitle, lessons: [] };
      modules.push(group);
    }
    group.lessons.push({
      id: row.lessonId,
      title: row.lessonTitle,
      number: position + 1,
      durationSeconds: row.durationSeconds,
      current: row.lessonId === lessonId,
    });
  }
  const following = ordered[index + 1];
  return {
    course: { slug: current.courseSlug, title: current.courseTitle, summary: current.courseSummary, teacherName: current.teacherName },
    lesson: {
      id: current.lessonId,
      title: current.lessonTitle,
      number: index + 1,
      durationSeconds: current.durationSeconds,
      moduleTitle: current.moduleTitle,
    },
    modules,
    next: following === undefined ? null : { id: following.lessonId, title: following.lessonTitle },
    lessonCount: ordered.length,
  };
}
