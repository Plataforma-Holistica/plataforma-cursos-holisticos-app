import "server-only";

import { giveSecondFactorCode, teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createAnomalyAlerts } from "./alerts";
import { databaseAnomalyStore } from "./store";

// Las alertas de anomalía y las decisiones de finanzas, ya armadas con la guarda del equipo, la
// base y el registro de errores. Lo que importan las pantallas (PA-68 mínima, T-208).

export type {
  AccountExcluded,
  AgeTier,
  AlertAccount,
  AlertExclusion,
  AlertKind,
  AlertReviewed,
  AlertsRead,
  ExcludeAnswer,
  ExclusionReason,
  ExclusionRevoked,
  ExclusionScope,
  FinanceAlert,
  FinanceAlerts,
  FinanceCode,
  ReviewAnswer,
  RevokeAnswer,
  ShareTier,
} from "./alerts";
export { EXCLUDE_ANSWERS, EXCLUSION_REASONS, NOTE_MAX, REASON_MAX, REVIEW_ANSWERS, REVOKE_ANSWERS } from "./alerts";

export const { anomalyAlerts, reviewAlert, decideFraud, excludeAccount, revokeExclusion, giveFinanceCode } = createAnomalyAlerts(
  { report: reportFailure },
  { teamStanding, giveSecondFactorCode, store: databaseAnomalyStore },
);
