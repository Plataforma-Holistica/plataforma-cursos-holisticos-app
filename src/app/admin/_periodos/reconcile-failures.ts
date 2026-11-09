import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";

import type { ReconcileAnswer, ReconcileFailure } from "./reconcile-outcomes";

// Lo que dice cada respuesta de la conciliación de PA-79 (T-303, cuarta solicitud). Escrita entera: una respuesta nueva no compila sin su texto. Viaja al
// navegador: no importa nada del servidor.

const text = admin.periods.reconciliation;

export const RECONCILE_FAILURES: Record<ReconcileFailure, string> = {
  needs_code: text.failures.needsCode,
  missing_note: text.failures.missingNote,
  not_explainable: text.failures.notExplainable,
  not_in_comparison: text.failures.notInComparison,
  closed: text.failures.closed,
  too_early: text.failures.tooEarly,
  rate_limited: text.failures.rateLimited,
  no_stripe: text.failures.noStripe,
  not_found: text.failures.notFound,
  unavailable: account.common.unavailable,
  unknown: text.failures.unknown,
};

export const RECONCILE_ANSWERS: Record<ReconcileAnswer, string> = {
  matches: text.answers.matches,
  mismatch: text.answers.mismatch,
  incomplete: text.answers.incomplete,
  explained: text.answers.explained,
  already_explained: text.answers.alreadyExplained,
};

/** El tono de lo que salió bien: coincidir y explicar, de éxito; no coincidir, de atención. */
export const answerTone = (answer: ReconcileAnswer): "success" | "warning" => (answer === "mismatch" || answer === "incomplete" ? "warning" : "success");

/** Las que son un error de la Plataforma (y no algo que falta hacer): van en tono de peligro. */
export const reconcileToneOf = (reason: ReconcileFailure): "danger" | "warning" =>
  reason === "unavailable" || reason === "unknown" || reason === "no_stripe" ? "danger" : "warning";
