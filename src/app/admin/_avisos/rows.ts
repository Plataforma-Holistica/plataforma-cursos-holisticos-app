import { clockTime, longDate, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import type { BillingQueueData, BillingQueueEvent, QueueStatus } from "@/services/billing/billing";
import type { StatusTone } from "@/ui/status-badge";

// PA-84 en palabras: cada aviso de la cola, como lo pinta la pantalla (T-303, tercera solicitud). Todo aquí es puro. El aviso no guarda su cuerpo: lo que hace falta
// ver se abre en el panel de Stripe, en el modo del aviso.
//
// Viaja al navegador: no importa nada del servidor.

const text = admin.billingEvents;

/** Lo que se le ofrece a una fila: las dos acciones, o por qué ninguna. */
export type RowOffer = "actions" | "waits" | "on_its_way" | "yours";

export interface BillingRow {
  key: string;
  id: string;
  revision: number;
  date: string;
  received: string;
  type: string;
  status: string;
  tone: StatusTone;
  attempts: string;
  /** El código dicho en palabras, o nulo si no hay. */
  error: string | null;
  eventId: string;
  objectId: string;
  stripeHref: string;
  testMode: boolean;
  offer: RowOffer;
}

export interface BillingView {
  /** Las acciones pasarían hoy la puerta sin pedir el código otra vez. */
  canChange: boolean;
  rows: BillingRow[];
  /** Cuántos no caben, en palabras, o nulo. */
  more: string | null;
}

/** Los códigos que dejan la base (`t303_bandeja`, `t303_cola`), el servidor (`inbox.ts`) y la lectura de Stripe (`stripe-read.ts`). Cada uno tiene su texto. */
export const BILLING_ERROR_CODES = [
  "attempts_exhausted",
  "second_live_subscription",
  "zero_invoice",
  "invoice_not_paid",
  "unknown_plan",
  "unknown_account",
  "account_mismatch",
  "unknown_subscription_status",
  "unsupported_currency",
  "charge_not_succeeded",
  "object_mismatch",
  "wrong_event_type",
  "malformed_snapshot",
  "charge_rule_unavailable",
  "charge_conflict",
  "charge_malformed",
  "charge_not_found",
  "charge_unsupported_currency",
  "charge_not_linked",
  "payments_not_linked",
  "payment_not_a_charge",
  "payment_amount_mismatch",
  "invoice_without_period",
  "invoice_without_subscription",
  "too_many_lines",
  "too_many_payments",
  "provider_not_found",
  "provider_rejected",
  "provider_unauthorized",
  "provider_unavailable",
  "provider_unreadable",
  "base_error",
  "stale",
  "waits_t307",
  "refund_waits_t307",
] as const;
type ErrorCode = (typeof BILLING_ERROR_CODES)[number];

/** `zero_invoice` es `zeroInvoice` en el catálogo de textos. */
const keyOf = (code: string) => code.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
const ERRORS: Readonly<Record<string, unknown>> = text.errors;
const isKnown = (code: string): code is ErrorCode => (BILLING_ERROR_CODES as readonly string[]).includes(code);

/** El código en palabras. Uno que no se conoce se dice tal cual: nunca se pierde. */
export function errorText(code: string): string {
  const known = isKnown(code) ? ERRORS[keyOf(code)] : undefined;
  return typeof known === "string" ? known : t(text.errors.unknown, { code });
}

const TYPES: Record<string, string> = {
  "invoice.paid": text.types.invoicePaid,
  "invoice.payment_failed": text.types.invoicePaymentFailed,
  "customer.subscription.created": text.types.subscriptionCreated,
  "customer.subscription.updated": text.types.subscriptionUpdated,
  "customer.subscription.deleted": text.types.subscriptionDeleted,
  "charge.refunded": text.types.chargeRefunded,
};
function typeText(type: string): string {
  if (type.startsWith("charge.dispute.")) return text.types.dispute;
  return TYPES[type] ?? t(text.types.other, { type });
}

const STATUS: Record<QueueStatus, { label: string; tone: StatusTone }> = {
  failed: { label: text.status.failed, tone: "bad" },
  deferred: { label: text.status.deferred, tone: "attention" },
  pending: { label: text.status.pending, tone: "active" },
  processing: { label: text.status.processing, tone: "active" },
};

/** El aviso en el panel de Stripe, en el modo del aviso. El id va escapado: no se arma otra dirección con él. */
export function stripeEventHref(id: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}events/${encodeURIComponent(id)}`;
}

function offerOf(event: BillingQueueEvent): RowOffer {
  if (event.isSelf) return "yours";
  if (event.status === "deferred") return "waits";
  if (event.status === "failed") return "actions";
  return "on_its_way";
}

function rowOf(event: BillingQueueEvent): BillingRow {
  const status = STATUS[event.status];
  return {
    key: event.id,
    id: event.id,
    revision: event.revision,
    date: longDate(event.occurredAt),
    received: t(text.received, { date: longDate(event.receivedAt), time: clockTime(event.receivedAt, PRODUCT_TIME_ZONE) }),
    type: typeText(event.eventType),
    status: status.label,
    tone: status.tone,
    attempts: t(plural(event.attempts, text.attempts), { count: event.attempts }),
    error: event.lastError === null ? null : errorText(event.lastError),
    eventId: event.providerEventId,
    objectId: event.objectId,
    stripeHref: stripeEventHref(event.providerEventId, event.livemode),
    testMode: !event.livemode,
    offer: offerOf(event),
  };
}

export function billingView(queue: BillingQueueData): BillingView {
  const hidden = queue.total - queue.events.length;
  return {
    canChange: queue.freshCode,
    rows: queue.events.map(rowOf),
    more: hidden > 0 ? t(plural(hidden, text.more), { count: hidden }) : null,
  };
}
