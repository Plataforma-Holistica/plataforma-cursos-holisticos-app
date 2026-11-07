import { z } from "zod";

import type { StripeGet } from "@/adapters/stripe/api";

// Lo que el servidor lee de Stripe para aplicar un aviso (T-303; RF-208). No se confía en el cuerpo del aviso: con su tipo y su objeto se lee el estado de ahora, con
// la versión fija de la API, y eso es lo que va a la base (`billing_apply`), que lo vuelve a revisar. Cada lectura contesta lo leído, `retry` (no se supo, o Stripe
// todavía no lo liga: se vuelve a intentar) o `failed` con un código (no se aplica nunca solo: queda a la vista de finanzas).
//
// Desde la API 2025-03-31.basil el cargo no trae su factura ni la factura su cargo: los pagos de una factura salen de `invoice_payments`, y la suscripción de una
// factura, de `parent.subscription_details`.

export interface SubscriptionSnapshot {
  id: string;
  customer: string | null;
  profile_id: string | null;
  status: string;
  interval: string;
  interval_count: number;
  currency: string;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  started_at: string;
  read_at: string;
}

export interface PaymentSnapshot {
  charge: string;
  subscription: string;
  status: string;
  invoice: string;
  charged_at: string;
  gross_cents: number;
  currency: string;
  method: "card" | "oxxo" | "bank_transfer" | "other";
  country: string | null;
  receipt_url: string | null;
  interval: string;
  interval_count: number;
  period_start: string;
  period_end: string;
  fee_cents: number | null;
  net_cents: number | null;
  balance_transaction: string | null;
  available_on: string | null;
}

export interface FailureSnapshot {
  subscription: string;
  invoice: string;
  failed_at: string;
  unpaid: boolean;
  cycle: boolean;
}

export type Read<T> = { kind: "ok"; value: T } | { kind: "retry"; code: string } | { kind: "failed"; code: string };

const id = z.string().regex(/^[!-~]{1,255}$/);
const ref = z.union([id, z.object({ id })]).transform((value) => (typeof value === "string" ? value : value.id));
const unix = z.number().int().nonnegative();

const subscriptionBody = z.object({
  id,
  customer: ref.nullable(),
  status: z.string(),
  currency: z.string(),
  cancel_at_period_end: z.boolean(),
  canceled_at: unix.nullable(),
  start_date: unix,
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  items: z.object({
    data: z.array(z.object({ price: z.object({ recurring: z.object({ interval: z.string(), interval_count: z.number().int() }).nullable() }) })).min(1),
  }),
});

const lineList = z.object({
  has_more: z.boolean(),
  data: z.array(z.object({ period: z.object({ start: unix, end: unix }), parent: z.object({ type: z.string() }).nullable().optional() })),
});

const invoiceBody = z.object({
  id,
  status: z.string().nullable(),
  billing_reason: z.string().nullable(),
  amount_paid: z.number().int(),
  parent: z.object({ type: z.string(), subscription_details: z.object({ subscription: ref }).nullable().optional() }).nullable().optional(),
  lines: lineList,
});

const invoicePayments = z.object({
  has_more: z.boolean(),
  data: z.array(
    z.object({
      invoice: ref,
      status: z.string(),
      payment: z.object({ type: z.string(), payment_intent: ref.nullable().optional(), charge: ref.nullable().optional() }),
    }),
  ),
});

const balanceTransaction = z.object({ id, amount: z.number().int(), fee: z.number().int(), net: z.number().int(), currency: z.string(), available_on: unix });

const chargeBody = z.object({
  id,
  status: z.string(),
  created: unix,
  amount_captured: z.number().int(),
  currency: z.string(),
  receipt_url: z.string().nullable().optional(),
  payment_intent: ref.nullable().optional(),
  payment_method_details: z.object({ type: z.string(), card: z.object({ country: z.string().nullable().optional() }).nullable().optional() }).nullable().optional(),
  billing_details: z.object({ address: z.object({ country: z.string().nullable().optional() }).nullable().optional() }).nullable().optional(),
  balance_transaction: z.union([id, balanceTransaction]).nullable().optional(),
});

const paymentIntentBody = z.object({ id, latest_charge: z.union([id, chargeBody]).nullable() });

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function read<T>(get: StripeGet, path: string, schema: z.ZodType<T>, query?: Record<string, string | string[]>): Promise<Read<T>> {
  const answer = await get(path, query);
  if (answer.status === "unavailable") return { kind: "retry", code: "provider_unavailable" };
  if (answer.status === "not_found") return { kind: "failed", code: "provider_not_found" };
  const parsed = schema.safeParse(answer.body);
  return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "failed", code: "provider_unreadable" };
}

/** La suscripción de ahora. La cuenta sale de su `metadata.profile_id`, que pone el Checkout (T-302); el plan, de su primer precio. */
export async function readSubscription(get: StripeGet, subscriptionId: string, now: Date): Promise<Read<SubscriptionSnapshot>> {
  const found = await read(get, `/v1/subscriptions/${subscriptionId}`, subscriptionBody);
  if (found.kind !== "ok") return found;
  const sub = found.value;
  const recurring = sub.items.data[0]?.price.recurring;
  if (recurring === null || recurring === undefined) return { kind: "failed", code: "unknown_plan" };
  return {
    kind: "ok",
    value: {
      id: sub.id,
      customer: sub.customer,
      profile_id: sub.metadata?.profile_id ?? null,
      status: sub.status,
      interval: recurring.interval,
      interval_count: recurring.interval_count,
      currency: sub.currency,
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at === null ? null : iso(sub.canceled_at),
      started_at: iso(sub.start_date),
      read_at: now.toISOString(),
    },
  };
}

function method(type: string | undefined): PaymentSnapshot["method"] {
  if (type === "card") return "card";
  if (type === "oxxo") return "oxxo";
  // La transferencia SPEI de Stripe en México entra al saldo del cliente.
  if (type === "customer_balance") return "bank_transfer";
  return "other";
}

const country = (value: string | null | undefined) => (value !== null && value !== undefined && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null);

/** El cargo con su transacción de saldo, por el PaymentIntent o directo. */
async function readCharge(get: StripeGet, payment: z.infer<typeof invoicePayments>["data"][number]["payment"]): Promise<Read<z.infer<typeof chargeBody>>> {
  if (payment.type === "payment_intent" && payment.payment_intent) {
    const intent = await read(get, `/v1/payment_intents/${payment.payment_intent}`, paymentIntentBody, { "expand[]": ["latest_charge.balance_transaction"] });
    if (intent.kind !== "ok") return intent;
    const charge = intent.value.latest_charge;
    if (charge === null || typeof charge === "string") return { kind: "retry", code: "charge_not_linked" };
    return { kind: "ok", value: charge };
  }
  if (payment.type === "charge" && payment.charge) {
    return read(get, `/v1/charges/${payment.charge}`, chargeBody, { "expand[]": ["balance_transaction"] });
  }
  return { kind: "failed", code: "payment_not_a_charge" };
}

export interface PaidInvoice {
  invoice: string;
  subscription: string;
  billingReason: string | null;
  payments: PaymentSnapshot[];
}

/**
 * Una factura pagada, con sus pagos. Una factura de 0 no tiene cobro y falla a la vista (decisión 7 de Sergio del 2026-11-06); una pagada sin pagos todavía ligados se
 * vuelve a intentar, porque Stripe los liga poco después.
 */
export async function readPaidInvoice(get: StripeGet, invoiceId: string, plan: { interval: string; interval_count: number }): Promise<Read<PaidInvoice>> {
  const found = await readInvoice(get, invoiceId);
  if (found.kind !== "ok") return found;
  const invoice = found.value;
  if (invoice.status !== "paid") return { kind: "failed", code: "invoice_not_paid" };
  if (invoice.amount_paid === 0) return { kind: "failed", code: "zero_invoice" };
  const paid = await read(get, "/v1/invoice_payments", invoicePayments, { invoice: invoiceId, status: "paid", limit: "100" });
  if (paid.kind !== "ok") return paid;
  if (paid.value.has_more) return { kind: "failed", code: "too_many_payments" };
  if (paid.value.data.length === 0) return { kind: "retry", code: "payments_not_linked" };
  const payments: PaymentSnapshot[] = [];
  for (const each of paid.value.data) {
    const charge = await readCharge(get, each.payment);
    if (charge.kind !== "ok") return charge;
    const c = charge.value;
    const bt = typeof c.balance_transaction === "object" && c.balance_transaction !== null && c.balance_transaction.currency === c.currency ? c.balance_transaction : null;
    payments.push({
      charge: c.id,
      subscription: invoice.subscription,
      status: c.status,
      invoice: invoiceId,
      charged_at: iso(c.created),
      gross_cents: c.amount_captured,
      currency: c.currency,
      method: method(c.payment_method_details?.type),
      country: country(c.payment_method_details?.card?.country ?? c.billing_details?.address?.country),
      receipt_url: c.receipt_url ?? null,
      interval: plan.interval,
      interval_count: plan.interval_count,
      period_start: invoice.periodStart,
      period_end: invoice.periodEnd,
      fee_cents: bt?.fee ?? null,
      net_cents: bt?.net ?? null,
      balance_transaction: bt?.id ?? null,
      available_on: bt === null ? null : iso(bt.available_on),
    });
  }
  return { kind: "ok", value: { invoice: invoiceId, subscription: invoice.subscription, billingReason: invoice.billing_reason, payments } };
}

/** La factura, con su suscripción y el periodo que paga (la línea de la suscripción que termina más tarde). */
export async function readInvoice(
  get: StripeGet,
  invoiceId: string,
): Promise<Read<z.infer<typeof invoiceBody> & { subscription: string; periodStart: string; periodEnd: string }>> {
  const found = await read(get, `/v1/invoices/${invoiceId}`, invoiceBody);
  if (found.kind !== "ok") return found;
  const invoice = found.value;
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (subscription === undefined) return { kind: "failed", code: "invoice_without_subscription" };
  let lines = invoice.lines.data;
  if (invoice.lines.has_more) {
    const all = await read(get, `/v1/invoices/${invoiceId}/lines`, lineList, { limit: "100" });
    if (all.kind !== "ok") return all;
    if (all.value.has_more) return { kind: "failed", code: "too_many_lines" };
    lines = all.value.data;
  }
  const ofSubscription = lines.filter((line) => line.parent?.type === "subscription_item_details");
  const latest = (ofSubscription.length > 0 ? ofSubscription : lines).reduce<(typeof lines)[number] | null>(
    (best, line) => (best === null || line.period.end > best.period.end ? line : best),
    null,
  );
  if (latest === null || latest.period.end <= latest.period.start) return { kind: "failed", code: "invoice_without_period" };
  return { kind: "ok", value: { ...invoice, subscription, periodStart: iso(latest.period.start), periodEnd: iso(latest.period.end) } };
}

/** La factura de un cargo: por su PaymentIntent, en los pagos de facturas. */
export async function readChargeInvoice(get: StripeGet, chargeId: string): Promise<Read<string>> {
  const charge = await read(get, `/v1/charges/${chargeId}`, chargeBody);
  if (charge.kind !== "ok") return charge;
  const intent = charge.value.payment_intent;
  if (intent === null || intent === undefined) return { kind: "failed", code: "charge_without_invoice" };
  const paid = await read(get, "/v1/invoice_payments", invoicePayments, { "payment[type]": "payment_intent", "payment[payment_intent]": intent, limit: "10" });
  if (paid.kind !== "ok") return paid;
  const invoice = paid.value.data[0]?.invoice;
  return invoice === undefined ? { kind: "failed", code: "charge_without_invoice" } : { kind: "ok", value: invoice };
}
