// El progreso como lo lee la Plataforma (RF-307; TRD §5.2; T-206). Lo que se vio y si una
// lección quedó terminada lo decide la base, en la misma transacción que registra los latidos
// (`private.merge_progress()`): el umbral y el fundido viven ahí una sola vez. Aquí se lee:
// en qué estado está cada lección, desde dónde arranca el video, cuánto lleva un curso y qué
// lección se le sugiere a quien vuelve. Puro: sin base, sin reloj.

/** Lo guardado de una lección para una cuenta, como lo lee la persona. */
export interface LessonProgressFacts {
  /** Los segundos distintos que vio y sirven (visibles, dentro de `VELOCIDAD_MAX`). */
  coveredSeconds: number;
  /** El segundo del video donde se quedó. */
  position: number;
  /** Si la terminó: una vez terminada, no se desmarca. */
  completed: boolean;
  /** Si lo guardado es del video que la lección tiene hoy. Si no, los tramos ya no dicen nada. */
  sameVideo: boolean;
}

export type LessonState = "not_started" | "in_progress" | "completed";

/**
 * Terminada, aunque el video haya cambiado después. A medias, si hay algo visto o una posición
 * del video de hoy: lo visto con la pestaña oculta no suma segundos pero sí mueve la posición.
 * Si no, sin empezar.
 */
export function lessonState(progress: LessonProgressFacts | null): LessonState {
  if (progress === null) return "not_started";
  if (progress.completed) return "completed";
  return progress.sameVideo && (progress.coveredSeconds > 0 || progress.position > 0) ? "in_progress" : "not_started";
}

/**
 * Cuánto del final cuenta como «ya la vio entera»: el 5 % de la lección, y al menos 10 segundos
 * (decisión de Sergio del 2026-10-20). Es una regla de la pantalla, no del reparto: no entra a
 * la tabla de parámetros.
 */
export const RESUME_RULES = { tailShare: 0.05, tailSeconds: 10 } as const;

/**
 * El segundo donde arranca el video: donde se quedó, en segundos enteros. Desde el principio si
 * no hay posición, si no tiene forma, o si le faltaba menos que la cola: quien vuelve a una
 * lección que vio casi entera quiere verla otra vez, no los últimos segundos.
 */
export function resumeAt(position: number | null, durationSeconds: number): number {
  if (position === null || !Number.isFinite(position) || position < 0) return 0;
  // Una duración de 0 o negativa cae sola en la cola, que mide al menos 10 s.
  if (!Number.isFinite(durationSeconds)) return 0;
  const start = Math.floor(position);
  const tail = Math.max(durationSeconds * RESUME_RULES.tailShare, RESUME_RULES.tailSeconds);
  return durationSeconds - start < tail ? 0 : start;
}

/** Cuántas lecciones vigentes del curso están terminadas, de cuántas, y si son todas. */
export function courseProgress(lessons: readonly { completed: boolean }[]): { completed: number; total: number; finished: boolean } {
  const completed = lessons.filter((lesson) => lesson.completed).length;
  return { completed, total: lessons.length, finished: lessons.length > 0 && completed === lessons.length };
}

/**
 * La lección que se le sugiere a quien vuelve a un curso (RF-307, FL-13; decisión de Sergio del
 * 2026-10-20): la última que vio, si no la terminó; si la terminó, la siguiente sin terminar del
 * temario, y si después no hay o la que vio ya no está en el temario (FL-13 A2), la primera sin
 * terminar. Nula si todas están terminadas.
 *
 * `lessons` va en el orden del temario, solo con las vigentes.
 */
export function suggestedLesson(lessons: readonly { id: string; completed: boolean }[], lastWatched: string | null): string | null {
  const index = lessons.findIndex((lesson) => lesson.id === lastWatched);
  const last = lessons[index];
  if (last !== undefined && !last.completed) return last.id;
  // Sin la última en el temario, `index` es -1 y se busca desde el principio.
  const after = lessons.slice(index + 1).find((lesson) => !lesson.completed);
  return (after ?? lessons.find((lesson) => !lesson.completed))?.id ?? null;
}
