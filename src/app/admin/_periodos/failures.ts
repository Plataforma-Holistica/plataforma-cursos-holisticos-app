import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";

import type { PeriodFailure } from "./outcomes";

// Lo que dice cada respuesta que no salió bien en PA-79 y PA-80. Escrita entera: una respuesta nueva no
// compila sin su texto. Viaja al navegador: no importa nada del servidor.

const text = admin.periods.failures;

export const FAILURES: Record<PeriodFailure, string> = {
  needs_code: text.needsCode,
  not_rollable: text.notRollable,
  too_soon: text.tooSoon,
  rehearsal_failed: text.rehearsalFailed,
  already_closed: text.alreadyClosed,
  no_period: text.noPeriod,
  photo_missing: text.photoMissing,
  no_pool_percent: text.noPoolPercent,
  before_launch: text.beforeLaunch,
  not_closing: text.notClosing,
  previous_not_closed: text.previousNotClosed,
  rollup_running: text.rollupRunning,
  last_rollup_failed: text.lastRollupFailed,
  needs_full_rollup: text.needsFullRollup,
  rollup_marks: text.rollupMarks,
  open_alerts: text.openAlerts,
  rehearsal_missing: text.rehearsalMissing,
  rehearsal_stale: text.rehearsalStale,
  timed_out: text.timedOut,
  unbalanced: text.unbalanced,
  not_found: text.notFound,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

/** Las que son un error de la Plataforma (y no algo que falta hacer): van en tono de peligro. */
export const toneOf = (reason: PeriodFailure): "danger" | "warning" =>
  reason === "unavailable" || reason === "unknown" || reason === "unbalanced" || reason === "timed_out" || reason === "rehearsal_failed" ? "danger" : "warning";
