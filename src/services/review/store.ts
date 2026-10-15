import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import type { ReviewStore } from "./queue";
import { approveAnswerOf, askApprove, readReviewQueue } from "./records";

// Lo que el servicio de revisión le pregunta a la base, a nombre de las claims que verificó:
// cada pregunta abre su transacción como servidor, con quién actúa y con qué sesión tomados
// de esas claims.

/** `run` es `asServer`. Las pruebas pasan otro: para ver qué se reintenta, o una transacción que se revierte. */
export function createReviewStore(run: typeof asServer = asServer): ReviewStore {
  return {
    // Solo lee y no toma candados: no hay choque que reintentar.
    queue: (claims) => run({ claims, reason: "review_queue" }, (tx) => readReviewQueue(tx)),
    // Aprobar toma los candados de las dos listas y el del curso, y no escribe antes de
    // rechazar: un choque revierte la transacción entera, y se intenta una vez más.
    approve: async (claims, courseId) =>
      approveAnswerOf(await withLockRetry(() => run({ claims, reason: "course_approval" }, (tx) => askApprove(tx, courseId)), isLockConflict)),
  };
}

export const databaseReviewStore = createReviewStore();
