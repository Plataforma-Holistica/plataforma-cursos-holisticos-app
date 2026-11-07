import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { StripeAnswer, StripeGet } from "@/adapters/stripe/api";

import { createBillingInbox, type BillingStore } from "./inbox";
import type { Applied, Claim, ClaimedEvent } from "./records";

const SECRET = "whsec_pruebaDelServicio0123456789";
const NOW = new Date("2026-11-06T18:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);
const PROFILE = "a0000000-0000-0000-0000-000000000001";

const SUBSCRIPTION = {
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  currency: "mxn",
  cancel_at_period_end: false,
  canceled_at: null,
  start_date: T - 3600,
  metadata: { profile_id: PROFILE },
  items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] },
};
const INVOICE = {
  id: "in_1",
  status: "paid",
  billing_reason: "subscription_cycle",
  amount_paid: 34900,
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
  lines: { has_more: false, data: [{ period: { start: T - 3600, end: T - 3600 + 30 * 86400 }, parent: { type: "subscription_item_details" } }] },
};
const CHARGE = {
  id: "ch_1",
  status: "succeeded",
  created: T - 60,
  amount_captured: 34900,
  currency: "mxn",
  receipt_url: "https://pay.stripe.com/receipts/ch_1",
  payment_intent: "pi_1",
  payment_method_details: { type: "card", card: { country: "mx" } },
  balance_transaction: { id: "txn_1", amount: 34900, fee: 1600, net: 33300, currency: "mxn", available_on: T + 2 * 86400 },
};
const PAYMENTS = { has_more: false, data: [{ invoice: "in_1", status: "paid", payment: { type: "payment_intent", payment_intent: "pi_1" } }] };

function stripeWith(overrides: Record<string, StripeAnswer> = {}): StripeGet & { calls: string[] } {
  const calls: string[] = [];
  const routes: Record<string, StripeAnswer> = {
    "/v1/subscriptions/sub_1": { status: "ok", body: SUBSCRIPTION },
    "/v1/invoices/in_1": { status: "ok", body: INVOICE },
    "/v1/invoice_payments": { status: "ok", body: PAYMENTS },
    "/v1/payment_intents/pi_1": { status: "ok", body: { id: "pi_1", latest_charge: CHARGE } },
    "/v1/charges/ch_1": { status: "ok", body: CHARGE },
    ...overrides,
  };
  const get = (path: string) => {
    calls.push(path);
    return Promise.resolve<StripeAnswer>(routes[path] ?? { status: "not_found" });
  };
  return Object.assign(get, { calls });
}

function event(type: string, object: string, extra: Record<string, unknown> = {}) {
  return { id: "evt_1", type, created: T - 30, livemode: false, api_version: "2026-10-28.endive", data: { object: { id: object } }, ...extra };
}

function signed(body: unknown, t = T): { body: Uint8Array; signature: string } {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { body: bytes, signature: `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.`).update(bytes).digest("hex")}` };
}

function setup(options: { stripe?: StripeGet | null; secret?: string | null; claim?: Claim; apply?: () => Promise<Applied>; status?: string } = {}) {
  const claimed = (type: string, object: string): ClaimedEvent => ({ id: "e1", attempt: 1, eventType: type, objectId: object, occurredAt: "2026-11-06T17:59:30.000Z" });
  let last: { type: string; object: string } = { type: "", object: "" };
  const store: BillingStore = {
    receive: vi.fn((received) => {
      last = { type: received.event_type, object: received.object_id };
      return Promise.resolve({ outcome: "stored" as const, id: "e1", status: options.status ?? "pending" });
    }),
    claim: vi.fn(() => Promise.resolve(options.claim ?? { outcome: "claimed" as const, event: claimed(last.type, last.object) })),
    claimDue: vi.fn(() => Promise.resolve([] as ClaimedEvent[])),
    release: vi.fn(() => Promise.resolve()),
    finish: vi.fn(() => Promise.resolve(true)),
    apply: vi.fn(options.apply ?? (() => Promise.resolve({ outcome: "processed" as const, subscription_id: "s1", recorded: 1 }))),
    health: vi.fn(() => Promise.resolve({ pending: 0, failed: 0, deferred: 0, oldest_pending_at: null })),
  };
  const report = vi.fn(() => Promise.resolve());
  const stripe = options.stripe === undefined ? stripeWith() : options.stripe;
  const raw = createBillingInbox({
    store,
    stripe: () => stripe,
    secret: () => (options.secret === undefined ? SECRET : options.secret),
    live: () => false,
    now: () => NOW,
    report,
    budgetMs: 200,
  });
  // Casi todas miran solo el código HTTP; la del tope mira también lo que sigue.
  const inbox = {
    receiveStripeEvent: async (body: Uint8Array, signature: string | null) => (await raw.receiveStripeEvent(body, signature)).status,
    sweepBillingEvents: raw.sweepBillingEvents,
  };
  return { inbox, raw, store, report, stripe };
}

describe("la entrega de un aviso", () => {
  it("sin las llaves de Stripe, la ruta no existe", async () => {
    const { inbox, store } = setup({ secret: null });
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(404);
    expect(store.receive).not.toHaveBeenCalled();
  });

  it("con la firma mala no se guarda nada, se contesta 400 y se reporta", async () => {
    const { inbox, store, report } = setup();
    const { body } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, `t=${T},v1=${"0".repeat(64)}`)).toBe(400);
    expect(store.receive).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("stripe_signature_invalid");
  });

  it("sin la cabecera de la firma: 400, sin guardar y sin reportar (no llena el registro de errores)", async () => {
    const { inbox, store, report } = setup();
    const { body } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, null)).toBe(400);
    expect(store.receive).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("con una firma vieja tampoco", async () => {
    const { inbox, store } = setup();
    const { body, signature } = signed(event("invoice.paid", "in_1"), T - 400);
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(400);
    expect(store.receive).not.toHaveBeenCalled();
  });

  it("un cuerpo firmado que no es un aviso: 400, sin guardar", async () => {
    const { inbox, store, report } = setup();
    const { body, signature } = signed({ hola: "mundo" });
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(400);
    expect(store.receive).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("stripe_event_unreadable");
  });

  it("un aviso firmado que no es de cobro y trae otra forma (un saldo) contesta 200, sin guardar: que Stripe no lo reenvíe", async () => {
    const { inbox, store } = setup();
    const { body, signature } = signed({ id: "evt_2", type: "balance.available", created: T, livemode: false, data: { object: { object: "balance" } } });
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.receive).not.toHaveBeenCalled();
  });

  it("un aviso del otro modo no se guarda ni se reenvía", async () => {
    const { inbox, store, report } = setup();
    const { body, signature } = signed(event("invoice.paid", "in_1", { livemode: true }));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.receive).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("stripe_wrong_mode");
  });

  it("guarda lo que dice el aviso y nada más, con la hora de Stripe", async () => {
    const { inbox, store } = setup();
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    await inbox.receiveStripeEvent(body, signature);
    expect(store.receive).toHaveBeenCalledWith({
      provider_event_id: "evt_1",
      event_type: "invoice.paid",
      livemode: false,
      api_version: "2026-10-28.endive",
      object_id: "in_1",
      occurred_at: new Date((T - 30) * 1000).toISOString(),
    });
  });

  it("una factura pagada: lee de Stripe la suscripción y el cargo, y los aplica", async () => {
    const { inbox, store } = setup();
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.apply).toHaveBeenCalledTimes(1);
    const [, subscription, payments, failure] = vi.mocked(store.apply).mock.calls[0]!;
    expect(subscription).toEqual({
      id: "sub_1",
      customer: "cus_1",
      profile_id: PROFILE,
      status: "active",
      interval: "month",
      interval_count: 1,
      currency: "mxn",
      cancel_at_period_end: false,
      canceled_at: null,
      started_at: new Date((T - 3600) * 1000).toISOString(),
      read_at: NOW.toISOString(),
    });
    expect(payments).toEqual([
      {
        charge: "ch_1",
        subscription: "sub_1",
        status: "succeeded",
        invoice: "in_1",
        charged_at: new Date((T - 60) * 1000).toISOString(),
        gross_cents: 34900,
        currency: "mxn",
        method: "card",
        country: "MX",
        receipt_url: "https://pay.stripe.com/receipts/ch_1",
        interval: "month",
        interval_count: 1,
        period_start: new Date((T - 3600) * 1000).toISOString(),
        period_end: new Date((T - 3600 + 30 * 86400) * 1000).toISOString(),
        fee_cents: 1600,
        net_cents: 33300,
        balance_transaction: "txn_1",
        available_on: new Date((T + 2 * 86400) * 1000).toISOString(),
      },
    ]);
    expect(failure).toBeNull();
  });

  it("la falla de una renovación lleva la hora del aviso, si sigue sin pagar y si es de ciclo", async () => {
    const stripe = stripeWith({ "/v1/invoices/in_1": { status: "ok", body: { ...INVOICE, status: "open" } } });
    const { inbox, store } = setup({ stripe });
    const { body, signature } = signed(event("invoice.payment_failed", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    const [, , payments, failure] = vi.mocked(store.apply).mock.calls[0]!;
    expect(payments).toEqual([]);
    expect(failure).toEqual({ subscription: "sub_1", invoice: "in_1", failed_at: "2026-11-06T17:59:30.000Z", unpaid: true, cycle: true });
  });

  it("el plan del cobro sale del periodo de la factura, no de la suscripción de ahora", async () => {
    const annual = { ...INVOICE, lines: { has_more: false, data: [{ period: { start: T - 3600, end: T - 3600 + 365 * 86400 }, parent: { type: "subscription_item_details" } }] } };
    const { inbox, store } = setup({ stripe: stripeWith({ "/v1/invoices/in_1": { status: "ok", body: annual } }) });
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(vi.mocked(store.apply).mock.calls[0]![2][0]).toMatchObject({ interval: "year", interval_count: 1 });
  });

  it("un periodo que no es de un mes ni de un año (un prorrateo) no se adivina", async () => {
    const odd = { ...INVOICE, lines: { has_more: false, data: [{ period: { start: T, end: T + 12 * 86400 }, parent: { type: "subscription_item_details" } }] } };
    const { inbox, store } = setup({ stripe: stripeWith({ "/v1/invoices/in_1": { status: "ok", body: odd } }) });
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), "failed", "unknown_plan");
  });

  it("un pago que no aplicó a la factura lo que se cobró en el cargo no se adivina", async () => {
    const payments = { has_more: false, data: [{ ...PAYMENTS.data[0]!, amount_paid: 10000 }] };
    const { inbox, store } = setup({ stripe: stripeWith({ "/v1/invoice_payments": { status: "ok", body: payments } }) });
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), "failed", "payment_amount_mismatch");
  });

  it("un cargo que cambió no se aplica: se ignora, sin leer nada", async () => {
    const { inbox, store, stripe } = setup();
    const { body, signature } = signed(event("charge.updated", "ch_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), "ignored", null);
    expect((stripe as ReturnType<typeof stripeWith>).calls).toEqual([]);
  });

  it("la factura se lee una sola vez", async () => {
    const { inbox, stripe } = setup();
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    await inbox.receiveStripeEvent(body, signature);
    expect((stripe as ReturnType<typeof stripeWith>).calls.filter((path) => path === "/v1/invoices/in_1")).toHaveLength(1);
  });

  it("una cancelación programada cuenta como no renovar", async () => {
    const stripe = stripeWith({ "/v1/subscriptions/sub_1": { status: "ok", body: { ...SUBSCRIPTION, cancel_at: T + 86400 } } });
    const { inbox, store } = setup({ stripe });
    const { body, signature } = signed(event("customer.subscription.updated", "sub_1"));
    await inbox.receiveStripeEvent(body, signature);
    expect(vi.mocked(store.apply).mock.calls[0]![1].cancel_at_period_end).toBe(true);
  });

  it("si Stripe rechaza la llave, vuelve a la fila y se reporta como configuración", async () => {
    const { inbox, store, report } = setup({ stripe: stripeWith({ "/v1/subscriptions/sub_1": { status: "unauthorized" } }) });
    const { body, signature } = signed(event("customer.subscription.updated", "sub_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(500);
    expect(store.release).toHaveBeenCalledWith(expect.anything(), "provider_unauthorized");
    expect(report).toHaveBeenCalledWith("stripe_key_rejected");
  });

  it("si Stripe contesta 400, no se reintenta: falla a la vista", async () => {
    const { inbox, store } = setup({ stripe: stripeWith({ "/v1/subscriptions/sub_1": { status: "rejected" } }) });
    const { body, signature } = signed(event("customer.subscription.updated", "sub_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), "failed", "provider_rejected");
  });

  it("la suscripción sola: sin pagos ni falla", async () => {
    const { inbox, store } = setup();
    const { body, signature } = signed(event("customer.subscription.updated", "sub_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(vi.mocked(store.apply).mock.calls[0]!.slice(2)).toEqual([[], null]);
  });

  it("un reembolso espera a T-307 sin leer nada de Stripe", async () => {
    const { inbox, store, stripe } = setup();
    const { body, signature } = signed(event("charge.refunded", "ch_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), "deferred", "refund_waits_t307");
    expect((stripe as ReturnType<typeof stripeWith>).calls).toEqual([]);
  });

  it("un tipo que no es de cobro se ignora", async () => {
    const { inbox, store } = setup();
    const { body, signature } = signed(event("customer.created", "cus_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), "ignored", null);
  });

  it("una factura de 0 queda fallida, a la vista (decisión 7 de Sergio)", async () => {
    const stripe = stripeWith({ "/v1/invoices/in_1": { status: "ok", body: { ...INVOICE, amount_paid: 0 } } });
    const { inbox, store, report } = setup({ stripe });
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(200);
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), "failed", "zero_invoice");
    expect(store.apply).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("billing_event_failed");
  });

  it("una pagada sin pagos ligados todavía vuelve a la fila, y Stripe la reenvía", async () => {
    const stripe = stripeWith({ "/v1/invoice_payments": { status: "ok", body: { has_more: false, data: [] } } });
    const { inbox, store } = setup({ stripe });
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(500);
    expect(store.release).toHaveBeenCalledWith(expect.anything(), "payments_not_linked");
  });

  it("si Stripe no contesta, vuelve a la fila con 500 y se reporta", async () => {
    const stripe = stripeWith({ "/v1/subscriptions/sub_1": { status: "unavailable" } });
    const { inbox, store, report } = setup({ stripe });
    const { body, signature } = signed(event("customer.subscription.updated", "sub_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(500);
    expect(store.release).toHaveBeenCalledWith(expect.anything(), "provider_unavailable");
    expect(report).toHaveBeenCalledWith("stripe_unavailable");
  });

  it("si la base dice que se vuelva a intentar, 500; si falló para siempre, 200 y se reporta", async () => {
    const retry = setup({ apply: () => Promise.resolve({ outcome: "retry", code: "second_live_subscription" }) });
    let s = signed(event("customer.subscription.updated", "sub_1"));
    expect(await retry.inbox.receiveStripeEvent(s.body, s.signature)).toBe(500);
    const failed = setup({ apply: () => Promise.resolve({ outcome: "failed", code: "unknown_account" }) });
    s = signed(event("customer.subscription.updated", "sub_1"));
    expect(await failed.inbox.receiveStripeEvent(s.body, s.signature)).toBe(200);
    expect(failed.report).toHaveBeenCalledWith("billing_event_failed");
  });

  it("un error de la base al aplicar lo deja en la fila", async () => {
    const { inbox, store, report } = setup({ apply: () => Promise.reject(new Error("se cayó")) });
    const { body, signature } = signed(event("customer.subscription.updated", "sub_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(500);
    expect(store.release).toHaveBeenCalledWith(expect.anything(), "base_error");
    expect(report).toHaveBeenCalledWith("billing_base_error");
  });

  it("si se acaba el tiempo, 500 sin esperar (Stripe lo reenvía), con lo que sigue aparte y su reporte", async () => {
    let finish: (value: Applied) => void = () => undefined;
    const { raw, report } = setup({ apply: () => new Promise<Applied>((resolve) => (finish = resolve)) });
    const { body, signature } = signed(event("customer.subscription.updated", "sub_1"));
    const delivery = await raw.receiveStripeEvent(body, signature);
    expect(delivery.status).toBe(500);
    expect(delivery.rest).toBeInstanceOf(Promise);
    expect(report).toHaveBeenCalledWith("billing_event_late");
    finish({ outcome: "processed", subscription_id: "s1", recorded: 0 });
    await expect(delivery.rest).resolves.toBeUndefined();
  });

  it("uno ya terminado, o que otro tiene, no se vuelve a procesar", async () => {
    const done = setup({ status: "processed" });
    let s = signed(event("invoice.paid", "in_1"));
    expect(await done.inbox.receiveStripeEvent(s.body, s.signature)).toBe(200);
    expect(done.store.claim).not.toHaveBeenCalled();
    const busy = setup({ claim: { outcome: "busy" } });
    s = signed(event("invoice.paid", "in_1"));
    expect(await busy.inbox.receiveStripeEvent(s.body, s.signature)).toBe(500);
    expect(busy.store.apply).not.toHaveBeenCalled();
  });

  it("si la base no contesta al guardar, 503 y Stripe lo reenvía", async () => {
    const { inbox, store } = setup();
    vi.mocked(store.receive).mockRejectedValueOnce(new Error("sin base"));
    const { body, signature } = signed(event("invoice.paid", "in_1"));
    expect(await inbox.receiveStripeEvent(body, signature)).toBe(503);
  });
});

describe("el barrido", () => {
  it("procesa lo que toca y reporta lo atorado", async () => {
    const { inbox, store, report } = setup();
    vi.mocked(store.claimDue).mockResolvedValueOnce([
      { id: "e9", attempt: 3, eventType: "customer.subscription.updated", objectId: "sub_1", occurredAt: "2026-11-05T00:00:00.000Z" },
    ]);
    vi.mocked(store.health).mockResolvedValueOnce({ pending: 1, failed: 0, deferred: 0, oldest_pending_at: "2026-11-04T00:00:00.000Z" });
    expect(await inbox.sweepBillingEvents()).toBe(true);
    expect(store.apply).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("billing_events_stuck");
  });

  it("lo que no alcanza en su tope vuelve a la fila sin procesarse", async () => {
    let clock = NOW.getTime();
    const { store } = setup();
    vi.mocked(store.claimDue).mockResolvedValueOnce([
      { id: "a", attempt: 1, eventType: "customer.subscription.updated", objectId: "sub_1", occurredAt: "2026-11-05T00:00:00.000Z" },
      { id: "b", attempt: 1, eventType: "customer.subscription.updated", objectId: "sub_1", occurredAt: "2026-11-05T00:00:00.000Z" },
    ]);
    vi.mocked(store.apply).mockImplementation(() => {
      clock += 120_000;
      return Promise.resolve({ outcome: "processed", subscription_id: "s1", recorded: 0 });
    });
    const inbox = createBillingInbox({ store, stripe: () => stripeWith(), secret: () => SECRET, live: () => false, now: () => new Date(clock), report: vi.fn(() => Promise.resolve()) });
    expect(await inbox.sweepBillingEvents()).toBe(true);
    expect(store.apply).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), "sweep_out_of_time");
  });

  it("si la base no contesta, lo dice", async () => {
    const { inbox, store } = setup();
    vi.mocked(store.claimDue).mockRejectedValueOnce(new Error("sin base"));
    expect(await inbox.sweepBillingEvents()).toBe(false);
  });
});
