import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import type { AnomalyStore } from "./alerts";
import { askAlertExclusion, askAlertReview, askExclusionRevocation, excludeAnswerOf, readFinanceAlerts, reviewAnswerOf, revokeAnswerOf } from "./records";

// Lo que el servicio de las alertas le pregunta a la base, a nombre de las claims que verificó:
// cada pregunta abre su transacción como servidor, con quién actúa y con qué sesión tomados de
// esas claims.

/** `run` es `asServer`. Las pruebas pasan otro: para ver qué se reintenta, o una transacción que se revierte. */
export function createAnomalyStore(run: typeof asServer = asServer): AnomalyStore {
  return {
    // Solo lee y no toma candados: no hay choque que reintentar.
    alerts: (claims) => run({ claims, reason: "finance_alerts" }, (tx) => readFinanceAlerts(tx)),
    // Las decisiones toman el candado de la cuenta y la fila de la alerta, y no escriben antes de
    // rechazar: un choque revierte la transacción entera, y se intenta una vez más.
    review: async (claims, alertId, note, isFraud, evidence) =>
      reviewAnswerOf(
        await withLockRetry(() => run({ claims, reason: "anomaly_review" }, (tx) => askAlertReview(tx, alertId, note, isFraud, evidence)), isLockConflict),
      ),
    exclude: async (claims, alertId, account, reasonCode, reason) =>
      excludeAnswerOf(
        await withLockRetry(() => run({ claims, reason: "consumption_exclusion" }, (tx) => askAlertExclusion(tx, alertId, account, reasonCode, reason)), isLockConflict),
      ),
    revoke: async (claims, exclusionId, reason) =>
      revokeAnswerOf(
        await withLockRetry(() => run({ claims, reason: "exclusion_revocation" }, (tx) => askExclusionRevocation(tx, exclusionId, reason)), isLockConflict),
      ),
  };
}

export const databaseAnomalyStore = createAnomalyStore();
