import { createHmac, randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMailpitSender } from "@/adapters/mailpit/send";
import type { StripeAnswer, StripeGet } from "@/adapters/stripe/api";
import type { Tx } from "@/adapters/supabase/db";
import { mailCopy } from "@/app/_lib/mail-copy";
import { createBillingInbox, type BillingFailure, type BillingStore } from "@/services/billing/inbox";
import { askApply, askClaim, askClaimDue, askCountRejection, askFinish, askHealth, askQueue, askReceive, askRelease, askRetry } from "@/services/billing/records";
import { createMailOutbox } from "@/services/mail/outbox";
import { askMailClaim, askMailHealth, askMailRejected, askMailSent } from "@/services/mail/records";

import { asFinance, financePerson, type Finance } from "./helpers/finance";
import { localOwnerUrl } from "./helpers/local";
import { lastMailTo, linksIn } from "./helpers/mailbox";
import { asOwner, asSystem, reverted } from "./helpers/team";
import { createTestUser, deleteTestUsers, deleteTestUsersByEmail, ownerQuery, type TestUser } from "./helpers/users";

// La cola de los avisos de punta a punta, contra la base local (T-303, tercera solicitud; RF-710, FL-55): finanzas de verdad reabre un aviso fallido y el servidor lo
// procesa en el momento, con Stripe simulado; si el barrido lo toma entre reabrirlo y reclamarlo, «Reintentar» lo dice sin gastar otro intento; lo que pasa del tope
// sigue aparte; y el décimo intento que falla de paso queda fallido y se reporta. CO-22 lo prueba `86_cola_de_avisos`: aquí finanzas solo existe dentro de sus
// transacciones, y nadie más recibe.

const SECRET = "whsec_integracion0123456789abcdef";
const PREFIX = `evt_it114_${randomUUID().slice(0, 8)}_`;
const people: TestUser[] = [];
const emails: string[] = [];
let finance: Finance;
let openedOctober = false;
let started: string;

beforeAll(async () => {
  started = (await ownerQuery<{ now: string }>("select clock_timestamp()::text as now"))[0]!.now;
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  openedOctober = (await ownerQuery<{ created: boolean }>("select private.open_period(202610) as created"))[0]!.created;
  finance = await financePerson(emails);
});

afterAll(async () => {
  const ids = `{${people.map((person) => person.id).join(",")}}`;
  // Los recibos de estas cuentas, y un CO-22 que haya dejado alguien con finanzas de la base local durante la corrida.
  await ownerQuery(
    `do $$ begin
       set local session_replication_role = replica;
       delete from private.mail_outbox where (template = 'CO-03' and profile_id = any('${ids}'::uuid[]))
                                         or (template = 'CO-22' and created_at >= '${started}'::timestamptz);
     end $$`,
  );
  if (people.length > 0) await deleteTestUsers(people);
  await ownerQuery(
    `do $$ begin
       set local session_replication_role = replica;
       delete from private.provider_event_actions where event_id in (select id from private.provider_events where provider_event_id like '${PREFIX}%');
       delete from private.provider_events where provider_event_id like '${PREFIX}%';
     end $$`,
  );
  // La persona de finanzas, con su sesión: lo que hizo ya no la nombra.
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
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

const txOf = (client: Client): Tx => ({
  query: async (query, row) => (await client.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await client.query(query.text, [...query.values])).rowCount ?? 0,
});

/** Cada llamada en su propia conexión, como el servidor sin persona. */
async function asServerSystem<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor_kind', 'system', true), set_config('role', 'app_service', true)");
    const result = await work(txOf(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Como finanzas, por el camino del servidor: su sesión, con el rol `app_service`. */
const asFinanceServer = <T>(work: (tx: Tx) => Promise<T>) =>
  asFinance(finance, async (client) => {
    await client.query("select set_config('role', 'app_service', true)");
    const result = await work(txOf(client));
    await client.query("select set_config('role', 'none', true)");
    return result;
  });

const store: BillingStore = {
  receive: (event) => asServerSystem((tx) => askReceive(tx, event)),
  claim: (id) => asServerSystem((tx) => askClaim(tx, id)),
  claimDue: (limit) => asServerSystem((tx) => askClaimDue(tx, limit)),
  release: (event, code) => asServerSystem((tx) => askRelease(tx, event.id, event.attempt, code)),
  finish: (event, status, code) => asServerSystem((tx) => askFinish(tx, event.id, event.attempt, status, code)),
  apply: (event, subscription, payments, failure) => asServerSystem((tx) => askApply(tx, event, subscription, payments, failure)),
  health: () => asServerSystem(askHealth),
  countRejection: () => asServerSystem(askCountRejection),
};

const T0 = Math.floor(Date.parse("2026-10-05T16:00:00Z") / 1000);

/** Una cuenta con su suscripción y su primer cobro en el Stripe simulado; la factura nace en 0 (queda fallida) hasta que se corrige, y Stripe puede tardar o caerse. */
async function world(options: { budgetMs?: number } = {}) {
  const person = await createTestUser();
  people.push(person);
  const tag = randomUUID().slice(0, 8);
  const ids = { sub: `sub_it114_${tag}`, invoice: `in_it114_${tag}`, charge: `ch_it114_${tag}`, intent: `pi_it114_${tag}` };
  const state = { zero: true, down: false, slowMs: 0 };
  const reported: BillingFailure[] = [];
  const answer = (body: unknown): StripeAnswer => ({ status: "ok", body });
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
  const route = (path: string): StripeAnswer => {
    if (state.down) return { status: "unavailable" };
    if (path === `/v1/subscriptions/${ids.sub}`) {
      return answer({
        id: ids.sub,
        customer: `cus_${tag}`,
        status: "active",
        currency: "mxn",
        cancel_at_period_end: false,
        canceled_at: null,
        start_date: T0,
        metadata: { profile_id: person.id },
        items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] },
      });
    }
    if (path === `/v1/invoices/${ids.invoice}`) {
      return answer({
        id: ids.invoice,
        status: "paid",
        billing_reason: "subscription_create",
        amount_paid: state.zero ? 0 : 34900,
        parent: { type: "subscription_details", subscription_details: { subscription: ids.sub } },
        lines: { has_more: false, data: [{ period: { start: T0, end: T0 + 31 * 86400 }, parent: { type: "subscription_item_details" } }] },
      });
    }
    if (path === "/v1/invoice_payments") {
      return answer({ has_more: false, data: [{ invoice: ids.invoice, status: "paid", payment: { type: "payment_intent", payment_intent: ids.intent } }] });
    }
    if (path === `/v1/payment_intents/${ids.intent}`) return answer({ id: ids.intent, latest_charge: charge });
    if (path === `/v1/charges/${ids.charge}`) return answer(charge);
    return { status: "not_found" };
  };
  const get: StripeGet = (path) =>
    new Promise((resolve) => {
      setTimeout(() => resolve(route(path)), state.slowMs);
    });
  const inbox = createBillingInbox({
    store,
    stripe: () => get,
    secret: () => SECRET,
    live: () => false,
    now: () => new Date(),
    report: (code) => (reported.push(code), Promise.resolve()),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  const deliver = (type: string, object: string, id = `${PREFIX}${randomUUID()}`) => {
    const t = Math.floor(Date.now() / 1000);
    const body = new TextEncoder().encode(JSON.stringify({ id, type, created: T0 + 60, livemode: false, api_version: "2026-10-28.endive", data: { object: { id: object } } }));
    const signature = `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.`).update(body).digest("hex")}`;
    return inbox.receiveStripeEvent(body, signature).then((delivery) => delivery.status);
  };
  return { person, ids, state, deliver, inbox, reported };
}

const eventOf = async (providerEventId: string) =>
  (
    await ownerQuery<{ id: string; status: string; attempts: number; last_error: string | null; revision: number }>(
      "select id, status, attempts, last_error, revision from private.provider_events where provider_event_id = $1",
      [providerEventId],
    )
  )[0]!;
const chargesOf = async (profile: string) =>
  (await ownerQuery<{ n: number }>("select count(*)::int as n from public.charges where profile_id = $1", [profile]))[0]!.n;

/** Un aviso de la factura en 0: queda fallido, a la vista. */
async function failedInvoice(options: { budgetMs?: number } = {}) {
  const w = await world(options);
  const providerEventId = `${PREFIX}${randomUUID()}`;
  expect(await w.deliver("invoice.paid", w.ids.invoice, providerEventId)).toBe(200);
  const event = await eventOf(providerEventId);
  expect(event).toMatchObject({ status: "failed", last_error: "zero_invoice" });
  return { ...w, providerEventId, event };
}

describe("la cola de los avisos de punta a punta", () => {
  it("finanzas lo ve en la cola, lo reabre con la revisión que vio, y el servidor lo procesa en el momento", async () => {
    const { person, providerEventId, event, state, inbox } = await failedInvoice();
    const queue = await asFinanceServer((tx) => askQueue(tx));
    expect(queue?.events.find((each) => each.id === event.id)).toMatchObject({ status: "failed", lastError: "zero_invoice", revision: event.revision, isSelf: false });
    // Stripe ya lo corrigió (la factura se pagó de verdad): reabrirlo lo aplica.
    state.zero = false;
    expect(await asFinanceServer((tx) => askRetry(tx, event.id, event.revision))).toBe("retried");
    expect((await inbox.processNow(event.id)).result).toEqual({ kind: "processed" });
    expect(await eventOf(providerEventId)).toMatchObject({ status: "processed", attempts: 1 });
    expect(await chargesOf(person.id)).toBe(1);
  });

  it("con lo que se vio antes de otro cambio, la base contesta que cambió y no lo reabre", async () => {
    const { event } = await failedInvoice();
    expect(await asFinanceServer((tx) => askRetry(tx, event.id, event.revision - 1))).toBe("changed");
  });

  it("si el barrido lo toma entre reabrirlo y reclamarlo, está en camino, sin gastar otro intento", async () => {
    const { providerEventId, event, state, inbox } = await failedInvoice();
    state.zero = false;
    expect(await asFinanceServer((tx) => askRetry(tx, event.id, event.revision))).toBe("retried");
    // Reabrir lo deja listo para ya: lo puede tomar el barrido o una entrega antes que «Reintentar». Se toma por su id, sin tocar avisos ajenos.
    const taken = await store.claim(event.id);
    expect(taken.outcome).toBe("claimed");
    expect((await inbox.processNow(event.id)).result).toEqual({ kind: "busy" });
    expect(await eventOf(providerEventId)).toMatchObject({ status: "processing", attempts: 1 });
    if (taken.outcome === "claimed") await store.release(taken.event, "provider_unavailable");
  });

  it("lo que pasa del tope sigue detrás de la respuesta, y termina", async () => {
    const { person, providerEventId, event, state, inbox } = await failedInvoice({ budgetMs: 100 });
    state.zero = false;
    state.slowMs = 300;
    expect(await asFinanceServer((tx) => askRetry(tx, event.id, event.revision))).toBe("retried");
    const run = await inbox.processNow(event.id);
    expect(run.result).toEqual({ kind: "still_pending" });
    await run.rest;
    expect(await eventOf(providerEventId)).toMatchObject({ status: "processed" });
    expect(await chargesOf(person.id)).toBe(1);
  });

  it("el décimo intento que falla de paso queda fallido en ese momento, y se reporta", async () => {
    const { providerEventId, event, state, deliver, ids, reported } = await failedInvoice();
    state.zero = false;
    state.down = true;
    expect(await asFinanceServer((tx) => askRetry(tx, event.id, event.revision))).toBe("retried");
    await ownerQuery(
      `do $$ begin
         set local session_replication_role = replica;
         update private.provider_events set attempts = 9 where id = '${event.id}';
       end $$`,
    );
    expect(await deliver("invoice.paid", ids.invoice, providerEventId)).toBe(500);
    expect(await eventOf(providerEventId)).toMatchObject({ status: "failed", attempts: 10, last_error: "attempts_exhausted" });
    expect(reported).toContain("billing_attempts_exhausted");
  });
});

describe("el aviso a finanzas (CO-22) de punta a punta", () => {
  it("un aviso que queda fallido le deja su CO-22 a quien tiene finanzas, y la salida de correo lo lleva al buzón", async () => {
    const person = await createTestUser();
    people.push(person);
    const email = person.email.toLowerCase();
    await reverted(async (owner) => {
      // Finanzas, solo dentro de esta transacción: dar capacidades queda en la auditoría.
      await owner.query("set local session_replication_role = replica");
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'finance')", [person.id]);
      await owner.query("set local session_replication_role = origin");
      await owner.query(
        `insert into private.provider_events (provider, provider_event_id, event_type, livemode, api_version, object_id, occurred_at)
         values ('stripe', $1, 'invoice.paid', false, '2026-10-28.endive', 'in_it114_correo', '2026-11-07T18:00:00Z')`,
        [`${PREFIX}correo`],
      );
      await owner.query("update private.provider_events set status = 'failed', last_error = 'zero_invoice' where provider_event_id = $1", [`${PREFIX}correo`]);
      const queued = await owner.query<{ recipient: string; params: Record<string, unknown> }>(
        "select recipient, params from private.mail_outbox where template = 'CO-22' and profile_id = $1",
        [person.id],
      );
      expect(queued.rows).toEqual([{ recipient: email, params: { count: 1, first_type: "invoice.paid", first_at: "2026-11-07T18:00:00+00:00" } }]);
      const system = async <T,>(work: (tx: Tx) => Promise<T>): Promise<T> => {
        await asSystem(owner);
        await owner.query("select set_config('role', 'app_service', true)");
        try {
          return await work(txOf(owner));
        } finally {
          await asOwner(owner);
        }
      };
      await createMailOutbox({
        store: {
          claim: (limit) => system((tx) => askMailClaim(tx, limit)),
          sent: (id) => system((tx) => askMailSent(tx, id)),
          rejected: (id, attempt) => system((tx) => askMailRejected(tx, id, attempt)),
          health: () => system(askMailHealth),
        },
        sender: () => createMailpitSender({ url: process.env.MAILPIT_URL ?? "http://127.0.0.1:54324" }),
        from: () => "Avisos <avisos@plataforma.local>",
        site: () => "https://plataforma.ejemplo.test",
        report: () => Promise.resolve(),
      }).dispatchMail(mailCopy);
      const sent = await owner.query<{ sent: boolean }>("select sent_at is not null as sent from private.mail_outbox where template = 'CO-22' and profile_id = $1", [
        person.id,
      ]);
      expect(sent.rows).toEqual([{ sent: true }]);
    });
    const mail = await lastMailTo(email);
    expect(mail.subject).toBe("Un aviso de cobro no se procesó");
    expect(mail.text).toContain("1 aviso de cobro no se pudo procesar.");
    expect(mail.text).toContain("Factura pagada");
    expect(linksIn(mail)).toEqual(["https://plataforma.ejemplo.test/admin/avisos-cobro"]);
  });
});
