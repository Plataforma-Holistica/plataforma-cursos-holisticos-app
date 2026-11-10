import { createHmac, randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StripeAnswer, StripeGet, StripePost, StripeWriteAnswer } from "@/adapters/stripe/api";
import { verifyAccessToken, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createCheckout } from "@/services/billing/checkout";
import { databaseCheckoutStore } from "@/services/billing/checkout-service";
import { createBillingInbox, type BillingStore } from "@/services/billing/inbox";
import { askApply, askClaim, askClaimDue, askCountRejection, askFinish, askHealth, askReceive, askRelease } from "@/services/billing/records";

import { connect } from "./helpers/finance";
import { localOwnerUrl } from "./helpers/local";
import { createTestUser, deleteTestUsers, ownerQuery, type TestUser } from "./helpers/users";

// Salir a pagar de punta a punta, contra la base local (T-302, segunda solicitud; RF-201, RF-202): el servicio de la salida con la base de verdad y Stripe simulado,
// y el aviso por la bandeja de verdad (T-303), con su firma. El criterio de T-302: el navegador regresa de pagar antes que el aviso, y no hay acceso hasta que llega.
// Además, que un doble clic abre una sola sesión, que un pago que Stripe ya cobró y cuyo aviso no llegó no deja abrir otro, y que con acceso no se sale a pagar.

const SECRET = "whsec_integracion117abcdef0123456789";
const PREFIX = `evt_it117_${randomUUID().slice(0, 8)}_`;
const people: TestUser[] = [];
let insertedDocument: string | null = null;
let openedPeriod: number | null = null;
let started: string;
let monthly: number;
let documentId: string;

beforeAll(async () => {
  started = (await ownerQuery<{ now: string }>("select clock_timestamp()::text as now"))[0]!.now;
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  const [period] = await ownerQuery<{ id: number }>("select to_char(now() at time zone 'America/Mexico_City', 'YYYYMM')::int as id");
  const [opened] = await ownerQuery<{ created: boolean }>("select private.open_period($1) as created", [period!.id]);
  if (opened!.created) openedPeriod = period!.id;
  monthly = Number((await ownerQuery<{ v: string }>("select private.parameter_value('PRECIO_MENSUAL') #>> '{}' as v"))[0]!.v);
  const [current] = await ownerQuery<{ id: string | null }>("select private.current_legal_document('recurring_charge_consent')::text as id");
  if (current?.id) documentId = current.id;
  else {
    const owner = await connect();
    try {
      await owner.query("begin");
      await owner.query("select set_config('app.actor_kind', 'system', true)");
      const inserted = await owner.query<{ id: string }>(
        `insert into public.legal_documents (doc_type, version, title, body, effective_from)
         values ('recurring_charge_consent', 1, 'Cobro recurrente', 'Acepto que el cobro se repite hasta que yo cancele.', now() - interval '1 minute')
         returning id::text as id`,
      );
      await owner.query("commit");
      insertedDocument = inserted.rows[0]!.id;
      documentId = insertedDocument;
    } finally {
      await owner.end();
    }
  }
});

afterAll(async () => {
  const ids = `{${people.map((person) => person.id).join(",")}}`;
  await ownerQuery(
    `do $$ begin
       set local session_replication_role = replica;
       delete from private.mail_outbox where template = 'CO-03' and profile_id = any('${ids}'::uuid[]);
       delete from private.mail_outbox where template = 'CO-22' and created_at >= '${started}'::timestamptz;
       delete from private.provider_events where provider_event_id like '${PREFIX}%';
       ${insertedDocument ? `delete from public.consents where legal_document_id = '${insertedDocument}'; delete from public.legal_documents where id = '${insertedDocument}';` : ""}
     end $$`,
  );
  if (people.length > 0) await deleteTestUsers(people);
  if (openedPeriod !== null) {
    await ownerQuery(
      `begin;
       alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
       delete from public.payout_periods p where p.period_id = ${openedPeriod}
         and not exists (select 1 from public.charges c where c.allocation_start_period_id = p.period_id);
       alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
       commit;`,
    );
  }
  await ownerQuery("revoke app_service from postgres");
});

/** Cada llamada de la bandeja en su propia conexión, como el servidor sin persona. */
async function asServerSystem<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor_kind', 'system', true), set_config('role', 'app_service', true)");
    const tx: Tx = {
      query: async (query, row) => (await client.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
      execute: async (query) => (await client.query(query.text, [...query.values])).rowCount ?? 0,
    };
    const result = await work(tx);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const inboxStore: BillingStore = {
  receive: (event) => asServerSystem((tx) => askReceive(tx, event)),
  claim: (id) => asServerSystem((tx) => askClaim(tx, id)),
  claimDue: (limit) => asServerSystem((tx) => askClaimDue(tx, limit)),
  release: (event, code) => asServerSystem((tx) => askRelease(tx, event.id, event.attempt, code)),
  finish: (event, status, code) => asServerSystem((tx) => askFinish(tx, event.id, event.attempt, status, code)),
  apply: (event, subscription, payments, failure) => asServerSystem((tx) => askApply(tx, event, subscription, payments, failure)),
  health: () => asServerSystem(askHealth),
  countRejection: () => asServerSystem(askCountRejection),
};

/** Una persona que sale a pagar, con su Stripe simulado: la salida, el pago y los avisos. */
async function world() {
  const person = await createTestUser({ claimed: true });
  people.push(person);
  // Las de verdad: el servidor solo acepta las claims que devuelve `verifyAccessToken`.
  const verified = await verifyAccessToken(person.accessToken);
  if (verified === null) throw new Error("El token de la persona de prueba no se verificó.");
  const claims: VerifiedClaims = verified;
  const tag = randomUUID().replaceAll("-", "").slice(0, 12);
  const t0 = Math.floor(Date.now() / 1000) - 60;
  const ids = { customer: `cus_it117${tag}`, sub: `sub_it117${tag}`, invoice: `in_it117${tag}`, charge: `ch_it117${tag}`, intent: `pi_it117${tag}` };
  const state = { paid: false, sessionsCreated: new Map<string, string>(), stripeHasLive: false };
  const answer = (body: unknown): StripeAnswer & StripeWriteAnswer => ({ status: "ok", body });

  const get: StripeGet = async (path, query = {}) => {
    if (path === "/v1/prices") {
      const keys = query["lookup_keys[]"];
      const key = typeof keys === "string" ? keys : keys?.[0];
      return answer({
        data: [{ id: "price_it117", lookup_key: key, active: true, currency: "mxn", unit_amount: monthly, tax_behavior: "inclusive", livemode: false, recurring: { interval: "month", interval_count: 1 } }],
      });
    }
    if (path === `/v1/customers/${ids.customer}`) return answer({ id: ids.customer, balance: 0 });
    if (path === "/v1/subscriptions") return answer({ data: state.paid || state.stripeHasLive ? [{ id: ids.sub, status: "active" }] : [] });
    if (path.startsWith("/v1/checkout/sessions/")) {
      const id = path.slice("/v1/checkout/sessions/".length);
      return answer({ id, status: state.paid ? "complete" : "open", subscription: state.paid ? ids.sub : null });
    }
    if (path === `/v1/subscriptions/${ids.sub}`) {
      return answer({
        id: ids.sub,
        customer: ids.customer,
        status: "active",
        currency: "mxn",
        cancel_at_period_end: false,
        canceled_at: null,
        start_date: t0,
        metadata: { profile_id: person.id },
        items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] },
      });
    }
    if (path === `/v1/invoices/${ids.invoice}`) {
      return answer({
        id: ids.invoice,
        status: "paid",
        billing_reason: "subscription_create",
        amount_paid: monthly,
        parent: { type: "subscription_details", subscription_details: { subscription: ids.sub } },
        lines: { has_more: false, data: [{ period: { start: t0, end: t0 + 31 * 86400 }, parent: { type: "subscription_item_details" } }] },
      });
    }
    if (path === "/v1/invoice_payments") {
      return answer({ has_more: false, data: [{ invoice: ids.invoice, status: "paid", payment: { type: "payment_intent", payment_intent: ids.intent } }] });
    }
    const charge = {
      id: ids.charge,
      status: "succeeded",
      created: t0,
      amount_captured: monthly,
      currency: "mxn",
      receipt_url: `https://pay.stripe.com/receipts/${ids.charge}`,
      payment_intent: ids.intent,
      payment_method_details: { type: "card", card: { country: "MX" } },
      balance_transaction: { id: `txn_${tag}`, amount: monthly, fee: 1600, net: monthly - 1600, currency: "mxn", available_on: t0 + 2 * 86400 },
    };
    if (path === `/v1/payment_intents/${ids.intent}`) return answer({ id: ids.intent, latest_charge: charge });
    if (path === `/v1/charges/${ids.charge}`) return answer(charge);
    return { status: "not_found" };
  };
  const posts: string[] = [];
  const post: StripePost = async (path, _form, key) => {
    posts.push(`${path} ${key}`);
    if (path === "/v1/customers") return answer({ id: ids.customer });
    if (path === "/v1/checkout/sessions") {
      const id = state.sessionsCreated.get(key) ?? `cs_test_it117${tag}${state.sessionsCreated.size}`;
      state.sessionsCreated.set(key, id);
      return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    return answer({ status: "expired" });
  };
  const checkout = createCheckout({
    store: databaseCheckoutStore,
    stripe: () => ({ get, post, live: false, test: false }),
    checkSession: async () => ({ kind: "pass", claims }),
    siteUrl: () => "http://localhost:3000",
    report: async () => undefined,
    now: () => new Date(),
  });
  const inbox = createBillingInbox({ store: inboxStore, stripe: () => get, secret: () => SECRET, live: () => false, now: () => new Date(), report: async () => undefined });
  const deliver = (type: string, object: string) => {
    const t = Math.floor(Date.now() / 1000);
    const body = new TextEncoder().encode(
      JSON.stringify({ id: `${PREFIX}${randomUUID()}`, type, created: t0 + 30, livemode: false, api_version: "2026-10-28.endive", data: { object: { id: object } } }),
    );
    const signature = `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.`).update(body).digest("hex")}`;
    return inbox.receiveStripeEvent(body, signature).then((delivery) => delivery.status);
  };
  const input = { plan: "monthly" as const, amountSeen: monthly, documentSeen: documentId, returnTo: "/cursos/uno", ip: "203.0.113.117", userAgent: "Navegador 117" };
  return { person, claims, ids, state, checkout, deliver, input, posts };
}

const sessionOf = (url: string) => /(cs_test_[A-Za-z0-9]+)/.exec(url)?.[1] ?? "";

describe("salir a pagar de punta a punta", () => {
  it("regresa de pagar antes que el aviso: sin acceso; llega el aviso: con acceso, y ya no sale a pagar", async () => {
    const w = await world();
    const started = await w.checkout.startCheckout({} as never, w.input);
    expect(started.kind).toBe("redirect");
    const session = sessionOf(started.kind === "redirect" ? started.url : "");

    // Paga en Stripe y regresa a PA-32 antes del aviso.
    w.state.paid = true;
    expect(await w.checkout.checkoutProgress(w.claims, session)).toEqual({ kind: "waiting", returnTo: "/cursos/uno" });
    expect(await w.checkout.planStanding(w.claims)).toMatchObject({ kind: "ready", access: false, blocking: true });

    // Llega el aviso, por la bandeja de verdad.
    expect(await w.deliver("customer.subscription.created", w.ids.sub)).toBe(200);
    expect(await w.deliver("invoice.paid", w.ids.invoice)).toBe(200);
    expect(await w.checkout.checkoutProgress(w.claims, session)).toEqual({ kind: "live", returnTo: "/cursos/uno" });
    expect(await w.checkout.planStanding(w.claims)).toMatchObject({ kind: "ready", access: true });
    expect(await w.checkout.startCheckout({} as never, w.input)).toEqual({ kind: "has_access" });
  });

  it("un doble clic: las dos peticiones a la vez llevan a la misma sesión", async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.checkout.startCheckout({} as never, w.input), w.checkout.startCheckout({} as never, w.input)]);
    expect(a.kind).toBe("redirect");
    expect(b).toEqual(a);
    expect(w.state.sessionsCreated.size).toBe(1);
    const [rows] = await ownerQuery<{ n: number }>("select count(*)::int as n from private.checkout_sessions where profile_id = $1", [w.person.id]);
    expect(rows!.n).toBe(1);
  });

  it("un pago que Stripe cobró y cuyo aviso no llegó, con la salida vencida por el reloj: no se abre otra", async () => {
    const w = await world();
    const first = await w.checkout.startCheckout({} as never, w.input);
    expect(first.kind).toBe("redirect");
    // La persona pagó y no volvió a PA-32; el aviso no llega. La salida pasa de su vencimiento.
    w.state.stripeHasLive = true;
    await ownerQuery(
      `do $$ begin set local session_replication_role = replica;
         update private.checkout_sessions set expires_at = now() - interval '10 minutes' where profile_id = '${w.person.id}';
       end $$`,
    );
    expect(await w.checkout.startCheckout({} as never, w.input)).toEqual({ kind: "in_progress" });
    expect(w.state.sessionsCreated.size).toBe(1);
  });
});
