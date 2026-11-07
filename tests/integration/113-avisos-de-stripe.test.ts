import { createHmac, randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StripeAnswer, StripeGet } from "@/adapters/stripe/api";
import type { Tx } from "@/adapters/supabase/db";
import { createBillingInbox, type BillingStore } from "@/services/billing/inbox";
import { askApply, askClaim, askClaimDue, askFinish, askHealth, askReceive, askRelease } from "@/services/billing/records";

import { localOwnerUrl } from "./helpers/local";
import { createTestUser, deleteTestUsers, ownerQuery, type TestUser } from "./helpers/users";

// Los avisos de Stripe de punta a punta, contra la base local (T-303; RF-208): el servicio de la ruta, con firmas de verdad, con Stripe simulado y con la base de
// verdad, como el servidor sin persona. Lo que `billing_apply` decide lo prueba `85_aplicar_avisos`; aquí, que todos los órdenes de un juego de avisos dejen el mismo
// estado final, que una falla a la mitad no deje nada a medias, y que el mismo aviso entregado diez veces a la vez deje un cobro y un recibo.

const SECRET = "whsec_integracion0123456789abcdef";
const PREFIX = `evt_it113_${randomUUID().slice(0, 8)}_`;
const people: TestUser[] = [];
let openedOctober = false;

beforeAll(async () => {
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  openedOctober = (await ownerQuery<{ created: boolean }>("select private.open_period(202610) as created"))[0]!.created;
});

afterAll(async () => {
  const ids = `{${people.map((person) => person.id).join(",")}}`;
  await ownerQuery(
    `do $$ begin
       set local session_replication_role = replica;
       delete from private.mail_outbox where template = 'CO-03' and profile_id = any('${ids}'::uuid[]);
     end $$`,
  );
  if (people.length > 0) await deleteTestUsers(people);
  await ownerQuery(
    `do $$ begin
       set local session_replication_role = replica;
       delete from private.provider_events where provider_event_id like '${PREFIX}%';
     end $$`,
  );
  if (openedOctober) {
    await ownerQuery(
      `begin;
       alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
       delete from public.payout_periods p where p.period_id = 202610
         and not exists (select 1 from public.charges c where c.allocation_start_period_id = p.period_id);
       alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
       commit;`,
    );
  }
  await ownerQuery("revoke app_service from postgres");
});

/** Cada llamada en su propia conexión, como el servidor sin persona: así corren a la vez como en la aplicación. */
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

const store: BillingStore = {
  receive: (event) => asServerSystem((tx) => askReceive(tx, event)),
  claim: (id) => asServerSystem((tx) => askClaim(tx, id)),
  claimDue: (limit) => asServerSystem((tx) => askClaimDue(tx, limit)),
  release: (event, code) => asServerSystem((tx) => askRelease(tx, event.id, event.attempt, code)),
  finish: (event, status, code) => asServerSystem((tx) => askFinish(tx, event.id, event.attempt, status, code)),
  apply: (event, subscription, payments, failure) => asServerSystem((tx) => askApply(tx, event, subscription, payments, failure)),
  health: () => asServerSystem(askHealth),
};

const T0 = Math.floor(Date.parse("2026-10-05T16:00:00Z") / 1000);

/** Una cuenta con su suscripción y su primer cobro en el Stripe simulado. Lo que se lea de él lo deciden las variables, para poder cambiarlo a media prueba. */
async function world() {
  const person = await createTestUser();
  people.push(person);
  const tag = randomUUID().slice(0, 8);
  const ids = { sub: `sub_it113_${tag}`, invoice: `in_it113_${tag}`, charge: `ch_it113_${tag}`, intent: `pi_it113_${tag}` };
  const state = { canceling: false, failing: false };
  const answer = (body: unknown): StripeAnswer => ({ status: "ok", body });
  const get: StripeGet = (path) => {
    if (state.failing && path.startsWith("/v1/invoice_payments")) return Promise.resolve({ status: "unavailable" });
    if (path === `/v1/subscriptions/${ids.sub}`) {
      return Promise.resolve(
        answer({
          id: ids.sub,
          customer: `cus_${tag}`,
          status: "active",
          currency: "mxn",
          cancel_at_period_end: state.canceling,
          canceled_at: state.canceling ? T0 + 600 : null,
          start_date: T0,
          metadata: { profile_id: person.id },
          items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] },
        }),
      );
    }
    if (path === `/v1/invoices/${ids.invoice}`) {
      return Promise.resolve(
        answer({
          id: ids.invoice,
          status: "paid",
          billing_reason: "subscription_create",
          amount_paid: 34900,
          parent: { type: "subscription_details", subscription_details: { subscription: ids.sub } },
          lines: { has_more: false, data: [{ period: { start: T0, end: T0 + 31 * 86400 }, parent: { type: "subscription_item_details" } }] },
        }),
      );
    }
    if (path === "/v1/invoice_payments") {
      return Promise.resolve(answer({ has_more: false, data: [{ invoice: ids.invoice, status: "paid", payment: { type: "payment_intent", payment_intent: ids.intent } }] }));
    }
    const charge = {
      id: ids.charge,
      status: "succeeded",
      created: T0,
      amount_captured: 34900,
      currency: "mxn",
      receipt_url: `https://pay.stripe.com/receipts/${ids.charge}`,
      payment_intent: ids.intent,
      payment_method_details: { type: "card", card: { country: "MX" } },
      balance_transaction: { id: `txn_${tag}`, amount: 34900, fee: 1600, net: 33300, currency: "mxn", available_on: T0 + 2 * 86400 },
    };
    if (path === `/v1/payment_intents/${ids.intent}`) return Promise.resolve(answer({ id: ids.intent, latest_charge: charge }));
    if (path === `/v1/charges/${ids.charge}`) return Promise.resolve(answer(charge));
    return Promise.resolve({ status: "not_found" });
  };
  const inbox = createBillingInbox({
    store,
    stripe: () => get,
    secret: () => SECRET,
    live: () => false,
    now: () => new Date(),
    report: () => Promise.resolve(),
  });
  const deliver = (type: string, object: string, id = `${PREFIX}${randomUUID()}`) => {
    const t = Math.floor(Date.now() / 1000);
    const body = new TextEncoder().encode(JSON.stringify({ id, type, created: T0 + 60, livemode: false, api_version: "2026-10-28.endive", data: { object: { id: object } } }));
    const signature = `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.`).update(body).digest("hex")}`;
    return inbox.receiveStripeEvent(body, signature);
  };
  return { person, ids, state, deliver, inbox };
}

async function finalState(profile: string) {
  const rows = await ownerQuery<{ status: string; period_end: string | null; cancel: boolean; charges: number; receipts: number; settlements: number }>(
    `select s.status::text, s.current_period_end::text as period_end, s.cancel_at_period_end as cancel,
            (select count(*)::int from public.charges c where c.profile_id = $1) as charges,
            (select count(*)::int from private.mail_outbox m where m.profile_id = $1 and m.template = 'CO-03') as receipts,
            (select count(*)::int from private.provider_settlements x join public.charges c on c.id = x.charge_id where c.profile_id = $1) as settlements
     from public.subscriptions s where s.profile_id = $1`,
    [profile],
  );
  return rows;
}

const ORDERS = [
  ["customer.subscription.created", "invoice.paid", "charge.updated", "customer.subscription.updated"],
  ["invoice.paid", "customer.subscription.created", "customer.subscription.updated", "charge.updated"],
  ["charge.updated", "customer.subscription.updated", "invoice.paid", "customer.subscription.created"],
  ["customer.subscription.updated", "charge.updated", "customer.subscription.created", "invoice.paid"],
  ["invoice.paid", "charge.updated", "customer.subscription.updated", "customer.subscription.created"],
  ["customer.subscription.created", "customer.subscription.updated", "charge.updated", "invoice.paid"],
];

describe("los avisos de Stripe de punta a punta", () => {
  it("todos los órdenes de un juego de avisos dejan el mismo estado final", async () => {
    const finals = [];
    for (const order of ORDERS) {
      const { person, ids, state, deliver } = await world();
      // La cancelación al final del periodo ya pasó en Stripe: cada lectura la ve, llegue el aviso que llegue primero.
      state.canceling = true;
      for (const type of order) {
        const object = type.startsWith("customer.") ? ids.sub : type === "charge.updated" ? ids.charge : ids.invoice;
        expect(await deliver(type, object)).toBe(200);
      }
      finals.push(await finalState(person.id));
    }
    const [first, ...rest] = finals;
    expect(first).toEqual([{ status: "active", period_end: expect.any(String), cancel: true, charges: 1, receipts: 1, settlements: 1 }]);
    for (const other of rest) expect(other).toEqual(first?.map((row) => ({ ...row, period_end: other[0]?.period_end })));
    expect(new Set(finals.map((each) => Date.parse(each[0]!.period_end!)))).toEqual(new Set([(T0 + 31 * 86400) * 1000]));
  });

  it("una falla a la mitad no deja nada a medias, y el reenvío lo completa", async () => {
    const { person, ids, state, deliver } = await world();
    const id = `${PREFIX}${randomUUID()}`;
    state.failing = true;
    expect(await deliver("invoice.paid", ids.invoice, id)).toBe(500);
    expect(await finalState(person.id)).toEqual([]);
    const pending = await ownerQuery<{ status: string; last_error: string }>("select status, last_error from private.provider_events where provider_event_id = $1", [id]);
    expect(pending).toEqual([{ status: "pending", last_error: "provider_unavailable" }]);
    state.failing = false;
    expect(await deliver("invoice.paid", ids.invoice, id)).toBe(200);
    expect(await finalState(person.id)).toEqual([{ status: "active", period_end: expect.any(String), cancel: false, charges: 1, receipts: 1, settlements: 1 }]);
  });

  it("el mismo aviso diez veces a la vez: un cobro y un recibo", async () => {
    const { person, ids, deliver } = await world();
    const id = `${PREFIX}${randomUUID()}`;
    const answers = await Promise.all(Array.from({ length: 10 }, () => deliver("invoice.paid", ids.invoice, id)));
    expect(answers.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect(answers.every((status) => status === 200 || status === 500)).toBe(true);
    expect(await finalState(person.id)).toEqual([{ status: "active", period_end: expect.any(String), cancel: false, charges: 1, receipts: 1, settlements: 1 }]);
    const events = await ownerQuery<{ n: number }>("select count(*)::int as n from private.provider_events where provider_event_id = $1 and status = 'processed'", [id]);
    expect(events[0]?.n).toBe(1);
  });

  it("diez avisos distintos del mismo cobro a la vez: también uno", async () => {
    const { person, ids, deliver } = await world();
    const answers = await Promise.all(Array.from({ length: 10 }, () => deliver("invoice.paid", ids.invoice)));
    expect(answers).toEqual(Array(10).fill(200));
    expect(await finalState(person.id)).toEqual([{ status: "active", period_end: expect.any(String), cancel: false, charges: 1, receipts: 1, settlements: 1 }]);
  });
});
