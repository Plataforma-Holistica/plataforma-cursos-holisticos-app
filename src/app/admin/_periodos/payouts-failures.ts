import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";

import type { PayoutStatus } from "@/services/periods/periods";

import type { FailureDetail, PayoutFailure } from "./payouts-outcomes";

// Lo que dice cada respuesta que no salió bien en PA-81. Escrita entera: una respuesta nueva no compila sin su
// texto. Viaja al navegador: no importa nada del servidor.

const text = admin.periods.payouts;
const failures = text.failures;
// El periodo como mes, como en `rows.ts` (que no viaja al navegador).
const MONTH = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });
const periodName = (period: number): string => MONTH.format(Date.UTC(Math.floor(period / 100), (period % 100) - 1, 1));

/** El texto de cada estado de una liquidación (el catálogo los nombra en camelCase). */
export const PAYOUT_STATUS_TEXT: Record<PayoutStatus, string> = {
  calculated: text.statuses.calculated,
  awaiting_invoice: text.statuses.awaitingInvoice,
  invoice_in_review: text.statuses.invoiceInReview,
  invoice_rejected: text.statuses.invoiceRejected,
  ready_to_pay: text.statuses.readyToPay,
  paid: text.statuses.paid,
  carried_forward: text.statuses.carriedForward,
  on_hold: text.statuses.onHold,
  payment_returned: text.statuses.paymentReturned,
};

const FIXED: Record<Exclude<PayoutFailure, "previous_not_released" | "not_holdable">, string> = {
  needs_code: failures.needsCode,
  tax_data_missing: failures.taxDataMissing,
  rules_missing: failures.rulesMissing,
  unhold_no_data: failures.unholdNoData,
  unhold_no_rule: failures.unholdNoRule,
  preview_changed: failures.previewChanged,
  changed: failures.changed,
  already_released: failures.alreadyReleased,
  not_closed: failures.notClosed,
  founder_pending: failures.founderPending,
  no_minimum: failures.noMinimum,
  already_held: failures.alreadyHeld,
  not_held: failures.notHeld,
  already_confirmed: failures.alreadyDecided.confirmed,
  already_void: failures.alreadyDecided.void,
  period_released: failures.periodReleased,
  self: t(failures.self),
  not_found: failures.notFound,
  timed_out: failures.timedOut,
  unbalanced: failures.unbalanced,
  unavailable: account.common.unavailable,
  unknown: failures.unknown,
};

/** Lo que se dice de una respuesta, con su periodo o su estado cuando los trae. */
export function payoutFailureText(reason: PayoutFailure, detail?: FailureDetail): string {
  if (reason === "previous_not_released") {
    return detail?.period === undefined ? failures.unknown : t(failures.previousNotReleased, { period: periodName(detail.period) });
  }
  if (reason === "not_holdable") {
    return detail?.status === undefined ? failures.changed : t(failures.notHoldable, { status: PAYOUT_STATUS_TEXT[detail.status] });
  }
  return FIXED[reason];
}

/** Las que son un error de la Plataforma (y no algo que falta hacer o que cambió): van en tono de peligro. */
export const payoutToneOf = (reason: PayoutFailure): "danger" | "warning" =>
  reason === "unavailable" || reason === "unknown" || reason === "unbalanced" || reason === "timed_out" ? "danger" : "warning";
