import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import type { BillingQueueStore } from "./queue";
import { askQueue, askQueueCount, askResolve, askRetry } from "./records";

// Lo que la cola de PA-84 le pregunta a la base, a nombre de las claims que verificó: cada pregunta abre su transacción como servidor, con quién actúa y con qué
// sesión tomados de esas claims.

/** `run` es `asServer`. Las pruebas pasan otro: una transacción que se revierte. */
export function createBillingQueueStore(run: typeof asServer = asServer): BillingQueueStore {
  return {
    // Solo leen y no toman candados.
    list: (claims) => run({ claims, reason: "billing_queue" }, askQueue),
    count: (claims) => run({ claims, reason: "billing_queue_count" }, askQueueCount),
    // Las dos toman la fila del aviso y no escriben antes de rechazar: un choque revierte la transacción entera, y se intenta una vez más.
    retry: (claims, event, revision) =>
      withLockRetry(() => run({ claims, reason: "billing_event_retry" }, (tx) => askRetry(tx, event, revision)), isLockConflict),
    resolve: (claims, event, note, revision) =>
      withLockRetry(() => run({ claims, reason: "billing_event_resolve" }, (tx) => askResolve(tx, event, note, revision)), isLockConflict),
  };
}

export const databaseBillingQueueStore = createBillingQueueStore();
