import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import type { ReviewStore } from "./queue";
import { approveAnswerOf, askApprove, askApproveSubmission, askReturn, readApproveAssets, readReviewQueue, returnAnswerOf, submissionApproveAnswerOf } from "./records";

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
    // Devolver toma el candado del curso y tampoco escribe antes de rechazar.
    returnCourse: async (claims, input) =>
      returnAnswerOf(await withLockRetry(() => run({ claims, reason: "course_return" }, (tx) => askReturn(tx, input)), isLockConflict)),
    // Solo lee la fotografía del envío.
    approveAssets: (claims, input) => run({ claims, reason: "course_approval" }, (tx) => readApproveAssets(tx, input)),
    // Aprobar lo enviado toma la fila del maestro y la de su cuenta, las listas, el curso y el registro. Antes de rechazar solo anota los subtítulos que dijo Mux: un choque revierte
    // todo, y se intenta una vez más.
    approveSubmission: async (claims, input) =>
      submissionApproveAnswerOf(await withLockRetry(() => run({ claims, reason: "course_approval" }, (tx) => askApproveSubmission(tx, input)), isLockConflict)),
  };
}

export const databaseReviewStore = createReviewStore();
