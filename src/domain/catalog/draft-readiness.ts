// Lo que le falta a un borrador para poder enviarlo a revisión (PA-42, «Faltan {n} cosas»; la lista de
// PA-44). Decisión de Sergio del 2026-10-29: cuenta el resumen, la práctica, el nivel, al menos un
// módulo con una lección y cada lección sin video. Una práctica o un nivel desactivados cuentan como
// que faltan: enviar a revisión (T-405) exige los activos.

export interface DraftReadiness {
  hasSummary: boolean;
  /** Elegida y activa. */
  practiceReady: boolean;
  /** Elegido y activo. */
  levelReady: boolean;
  /** Las lecciones del borrador. Hasta T-403 ninguna tiene video, así que todas cuentan. */
  lessons: number;
  modulesWithLessons: number;
}

/** Cuántas cosas faltan. Cero es «Listo para enviar». */
export function missingItems(readiness: DraftReadiness): number {
  const flags = [readiness.hasSummary, readiness.practiceReady, readiness.levelReady, readiness.modulesWithLessons > 0];
  return flags.filter((done) => !done).length + readiness.lessons;
}
