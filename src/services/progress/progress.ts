import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asUser } from "@/adapters/supabase/db";

import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import { continueWatchingOf, type ContinueCourse, type ContinueRowData } from "./continue";
import { readContinueWatching } from "./records";

// El progreso que se pinta fuera de la lección (RF-307; T-206): «continuar viendo», mientras no
// exista PA-20 en el inicio provisional (decisión de Sergio del 2026-10-20). Lo que se vio y si
// se terminó lo escribe la base al registrar los latidos (`src/services/media/`); aquí solo se
// lee, como la persona.

export type { ContinueCourse } from "./continue";

export type ContinueWatchingAnswer = { kind: "ready"; courses: ContinueCourse[] } | { kind: "unavailable" };

export interface ProgressStore {
  /** Las lecciones vigentes de los cursos que la persona empezó, leídas como ella. */
  continueRows(claims: VerifiedClaims): Promise<ContinueRowData[]>;
}

export function createProgress(deps: { store: ProgressStore; report: (code: FailureCode) => Promise<void> }) {
  /**
   * Los cursos empezados y sin terminar de quien trae esas claims (las que la guarda le dio a la
   * página), el más reciente primero. «No se supo» se reporta: el inicio se pinta sin la lista.
   */
  async function continueWatching(claims: VerifiedClaims): Promise<ContinueWatchingAnswer> {
    let rows: ContinueRowData[];
    try {
      rows = await deps.store.continueRows(claims);
    } catch {
      await deps.report("continue_watching_unavailable");
      return { kind: "unavailable" };
    }
    return { kind: "ready", courses: continueWatchingOf(rows) };
  }

  return { continueWatching };
}

export const databaseProgressStore: ProgressStore = {
  continueRows: (claims) => asUser(claims, (tx) => readContinueWatching(tx)),
};

export const { continueWatching } = createProgress({ store: databaseProgressStore, report: reportFailure });
