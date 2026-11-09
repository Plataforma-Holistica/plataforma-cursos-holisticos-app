import "server-only";

import { createStripeApi, type StripeGet } from "@/adapters/stripe/api";
import { asSystem } from "@/adapters/supabase/db";
import { getEnv } from "@/config/env";
import { giveSecondFactorCode, teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";
import { secretMatches } from "@/services/mail/outbox";

import { createBillingInbox } from "./inbox";
import { createBillingQueue } from "./queue";
import { databaseBillingQueueStore } from "./queue-store";
import { createReconciliation } from "./reconcile";
import { databaseReconcileStore } from "./reconcile-store";
import { askApply, askClaim, askClaimDue, askCountRejection, askFinish, askHealth, askReceive, askRelease } from "./records";

// La bandeja de los avisos de Stripe, ya armada: lo que importan la ruta del aviso y la del barrido (T-303). Corre como sistema: un aviso no tiene una persona detrás.
// Sin `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` la ruta del aviso contesta como si no existiera. Abajo, la cola de PA-84 para finanzas, que reabre como la persona y
// procesa como sistema.

function stripe(): StripeGet | null {
  const key = getEnv().STRIPE_SECRET_KEY;
  return key === undefined ? null : createStripeApi({ secretKey: key });
}

export const { receiveStripeEvent, sweepBillingEvents, noteOversizedBody, processNow } = createBillingInbox({
  store: {
    receive: (event) => asSystem({ reason: "billing_receive" }, (tx) => askReceive(tx, event)),
    claim: (id) => asSystem({ reason: "billing_claim" }, (tx) => askClaim(tx, id)),
    claimDue: (limit) => asSystem({ reason: "billing_claim" }, (tx) => askClaimDue(tx, limit)),
    release: (event, code) => asSystem({ reason: "billing_release" }, (tx) => askRelease(tx, event.id, event.attempt, code)),
    finish: (event, status, code) => asSystem({ reason: "billing_finish" }, (tx) => askFinish(tx, event.id, event.attempt, status, code)),
    apply: (event, subscription, payments, failure) =>
      asSystem({ reason: "billing_apply" }, (tx) => askApply(tx, event, subscription, payments, failure)),
    health: () => asSystem({ reason: "billing_health" }, askHealth),
    countRejection: () => asSystem({ reason: "billing_rejection" }, askCountRejection),
  },
  stripe,
  secret: () => getEnv().STRIPE_WEBHOOK_SECRET ?? null,
  live: () => /^(sk|rk)_live_/.test(getEnv().STRIPE_SECRET_KEY ?? ""),
  now: () => new Date(),
  report: reportFailure,
});

/** Si la ruta del aviso existe: con la llave de Stripe y el secreto del punto de conexión. */
export const stripeWebhookEnabled = (): boolean => getEnv().STRIPE_SECRET_KEY !== undefined && getEnv().STRIPE_WEBHOOK_SECRET !== undefined;

/** Si lo que llegó es la llave del barrido programado (la misma de la salida de correo). */
export const billingSweepAllowed = (token: string | null): boolean => secretMatches(getEnv().CRON_SECRET, token);

export type {
  BillingCode,
  BillingQueueData,
  BillingQueueEvent,
  EventResolved,
  EventRetried,
  QueueCount,
  QueueRead,
  QueueStatus,
  ResolveAnswer,
  RetryAnswer,
} from "./queue";
export type { ManualRun } from "./inbox";
export { RESOLVE_NOTE_MAX } from "./queue";

export const { billingQueue, billingQueueCount, retryBillingEvent, resolveBillingEvent, giveBillingCode } = createBillingQueue(
  { report: reportFailure },
  { teamStanding, giveSecondFactorCode, store: databaseBillingQueueStore, processNow },
);

// La conciliación con Stripe (T-303, cuarta solicitud): el trabajo de cada día, y «Comparar ahora» y «Explicar» de PA-79. Sin `STRIPE_SECRET_KEY` no compara:
// ningún mes se puede cerrar hasta que haya llave.
export type { CompareNow, Compared, ExplainAnswer, Explained } from "./reconcile";
export { EXPLAIN_NOTE_MAX } from "./reconcile";

export const { sweepReconciliations, compareNow, explainDifference } = createReconciliation(
  { report: reportFailure },
  {
    teamStanding,
    store: databaseReconcileStore,
    stripe,
    live: () => /^(sk|rk)_live_/.test(getEnv().STRIPE_SECRET_KEY ?? ""),
    now: () => Date.now(),
  },
);
