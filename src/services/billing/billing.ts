import "server-only";

import { createStripeApi, type StripeGet } from "@/adapters/stripe/api";
import { asSystem } from "@/adapters/supabase/db";
import { getEnv } from "@/config/env";
import { reportFailure } from "@/services/error-reporting/server";
import { secretMatches } from "@/services/mail/outbox";

import { createBillingInbox } from "./inbox";
import { askApply, askClaim, askClaimDue, askCountRejection, askFinish, askHealth, askReceive, askRelease } from "./records";

// La bandeja de los avisos de Stripe, ya armada: lo que importan la ruta del aviso y la del barrido (T-303). Corre como sistema: un aviso no tiene una persona detrás.
// Sin `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` la ruta del aviso contesta como si no existiera.

function stripe(): StripeGet | null {
  const key = getEnv().STRIPE_SECRET_KEY;
  return key === undefined ? null : createStripeApi({ secretKey: key });
}

export const { receiveStripeEvent, sweepBillingEvents, noteOversizedBody } = createBillingInbox({
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
