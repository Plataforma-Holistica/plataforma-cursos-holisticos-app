import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, waitBehind } from "./helpers/finance";
import { createTestUser, deleteTestUsers, ownerQuery, type TestUser } from "./helpers/users";

// Los avisos de Stripe a la vez, contra la base local (T-303; RF-208). Lo que aplica `private.billing_apply` lo prueba
// `supabase/tests/85_aplicar_avisos.test.sql`, que se revierte; aquí, lo que una transacción revertida no puede: que el mismo cobro desde diez avisos a la vez
// deje un cobro, un recibo y una liquidación; que dos suscripciones vivas de la misma cuenta a la vez dejen una y la otra a la vista; y que diez reenvíos del
// mismo aviso lo reclamen una vez. Corre como el servidor sin persona (el camino del aviso), con el rol `app_service`; lo confirmado se quita al terminar.

const CALLERS = 9;
const PREFIX = `evt_it112_${randomUUID().slice(0, 8)}_`;
let owner: Client;
let ana: TestUser;
let beto: TestUser;
let openedOctober = false;

beforeAll(async () => {
  owner = await connect();
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  openedOctober = (await ownerQuery<{ created: boolean }>("select private.open_period(202610) as created"))[0]!.created;
  ana = await createTestUser();
  beto = await createTestUser();
});

afterAll(async () => {
  const people = [ana, beto].filter(Boolean);
  await ownerQuery(
    `do $$ begin
       set local session_replication_role = replica;
       delete from private.mail_outbox where template = 'CO-03' and profile_id = any('{${people.map((person) => person.id).join(",")}}'::uuid[]);
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
  await owner?.end();
});

/** Como corre la ruta del aviso: el servidor, como sistema, en la transacción que esté abierta. */
async function asServerSystem(client: Client): Promise<void> {
  await client.query(
    "select set_config('app.actor_kind', 'system', false), set_config('app.actor_id', '', false), set_config('role', 'app_service', false)",
  );
}

async function receive(client: Client, event: string, object: string, type = "invoice.paid") {
  const result = await client.query<{ answer: { outcome: string; id: string; status?: string } }>(
    `select private.provider_event_receive('stripe', $1, $2, false, null, $3, now() - interval '1 minute') as answer`,
    [event, type, object],
  );
  return result.rows[0]!.answer;
}

async function claim(client: Client, id: string) {
  const result = await client.query<{ answer: { outcome: string; attempt?: number } }>("select private.provider_event_claim($1) as answer", [id]);
  return result.rows[0]!.answer;
}

/** Un aviso nuevo de la suscripción, guardado y reclamado en su propia conexión, listo para aplicarse. */
async function claimed(object: string, type = "customer.subscription.updated", attemptsBefore = 0): Promise<{ id: string; attempt: number }> {
  const event = `${PREFIX}${randomUUID()}`;
  const client = await connect();
  try {
    await asServerSystem(client);
    const { id } = await receive(client, event, object, type);
    if (attemptsBefore > 0) {
      await ownerQuery(
        `do $$ begin set local session_replication_role = replica; update private.provider_events set attempts = ${attemptsBefore} where id = '${id}'; end $$`,
      );
    }
    const answer = await claim(client, id);
    expect(answer.outcome).toBe("claimed");
    return { id, attempt: answer.attempt! };
  } finally {
    await client.end();
  }
}

function subscription(id: string, profile: string, read: string) {
  return {
    id, customer: `cus_${id}`, profile_id: profile, status: "active", interval: "month", interval_count: 1, currency: "mxn",
    cancel_at_period_end: false, canceled_at: null, started_at: "2026-10-01T16:00:00Z", read_at: read,
  };
}

function payment(charge: string, subscription: string) {
  return {
    charge, subscription, status: "succeeded", invoice: `in_${charge}`, charged_at: "2026-10-01T16:00:00Z", gross_cents: 34900, currency: "mxn", method: "card", country: "MX",
    receipt_url: `https://pay.stripe.com/receipts/${charge}`, interval: "month", interval_count: 1,
    period_start: "2026-10-01T16:00:00Z", period_end: "2026-11-01T16:00:00Z",
    fee_cents: 1600, net_cents: 33300, balance_transaction: `txn_${charge}`, available_on: "2026-10-03T16:00:00Z",
  };
}

async function apply(client: Client, claim: { id: string; attempt: number }, sub: object, payments: object[]) {
  const result = await client.query<{ answer: { outcome: string; code?: string } }>(
    "select private.billing_apply($1, $2, $3::jsonb, $4::jsonb, null) as answer",
    [claim.id, claim.attempt, JSON.stringify(sub), JSON.stringify(payments)],
  );
  return result.rows[0]!.answer;
}

async function ledgerOf(profile: string) {
  const rows = await ownerQuery<{ charges: number; receipts: number; settlements: number; live: number; event_ids: number }>(
    `select (select count(*)::int from public.charges where profile_id = $1) as charges,
            (select count(*)::int from private.mail_outbox where profile_id = $1 and template = 'CO-03') as receipts,
            (select count(*)::int from private.provider_settlements s join public.charges c on c.id = s.charge_id where c.profile_id = $1) as settlements,
            (select count(*)::int from public.subscriptions where profile_id = $1 and status in ('active', 'in_grace')) as live,
            (select count(distinct provider_event_id)::int from public.charges where profile_id = $1) as event_ids`,
    [profile],
  );
  return rows[0]!;
}

describe("los avisos de Stripe a la vez", () => {
  it("el mismo cobro desde diez avisos a la vez deja un cobro, un recibo y una liquidación", async () => {
    const sub = `sub_it112_${randomUUID().slice(0, 8)}`;
    const charge = `ch_it112_${randomUUID().slice(0, 8)}`;
    const claims = await Promise.all(Array.from({ length: CALLERS + 1 }, () => claimed(sub)));
    const [first, ...others] = await Promise.all(claims.map(() => connect()));
    try {
      for (const client of [first!, ...others]) await asServerSystem(client);
      await first!.query("begin");
      expect((await apply(first!, claims[0]!, subscription(sub, ana.id, "2026-10-01T16:00:05Z"), [payment(charge, sub)])).outcome).toBe("processed");
      const waiting = Promise.all(
        others.map(async (client, index) => {
          await client.query("begin");
          const answer = await apply(client, claims[index + 1]!, subscription(sub, ana.id, `2026-10-01T16:00:${10 + index}Z`), [payment(charge, sub)]);
          await client.query("commit");
          return answer;
        }),
      );
      await waitBehind(owner, first!, CALLERS);
      await first!.query("commit");
      const answers = await waiting;
      expect(answers.map((answer) => answer.outcome)).toEqual(Array(CALLERS).fill("processed"));
      expect(await ledgerOf(ana.id)).toEqual({ charges: 1, receipts: 1, settlements: 1, live: 1, event_ids: 1 });
      const events = await ownerQuery<{ status: string }>("select status from private.provider_events where id = any($1::uuid[])", [
        claims.map((each) => each.id),
      ]);
      expect(events.map((event) => event.status)).toEqual(Array(CALLERS + 1).fill("processed"));
    } finally {
      await Promise.all([first, ...others].map((client) => client?.query("rollback").catch(() => undefined)));
      await Promise.all([first, ...others].map((client) => client?.end()));
    }
  });

  it("dos suscripciones vivas de la misma cuenta a la vez: una queda, y la otra vuelve a la fila aunque sea su quinto intento; al reintentarla entra su cobro, sin acceso", async () => {
    const sub1 = `sub_it112_${randomUUID().slice(0, 8)}`;
    const sub2 = `sub_it112_${randomUUID().slice(0, 8)}`;
    // La segunda va en su quinto intento: un choque de unicidad no escribió nada, así que vuelve a la fila igual, para que el intento siguiente registre su cobro.
    const [one, two] = await Promise.all([claimed(sub1), claimed(sub2, "customer.subscription.updated", 4)]);
    const [first, second] = await Promise.all([connect(), connect()]);
    try {
      await asServerSystem(first);
      await asServerSystem(second);
      await first.query("begin");
      expect((await apply(first, one!, subscription(sub1, beto.id, "2026-10-01T16:00:05Z"), [payment(`ch_it112_${randomUUID().slice(0, 8)}`, sub1)])).outcome).toBe(
        "processed",
      );
      const waiting = (async () => {
        await second.query("begin");
        const answer = await apply(second, two!, subscription(sub2, beto.id, "2026-10-01T16:00:06Z"), [payment(`ch_it112_${randomUUID().slice(0, 8)}`, sub2)]);
        await second.query("commit");
        return answer;
      })();
      await waitBehind(owner, first, 1);
      await first.query("commit");
      expect(await waiting).toEqual({ outcome: "retry", code: "second_live_subscription" });
      expect(await ledgerOf(beto.id)).toMatchObject({ charges: 1, receipts: 1, live: 1 });
      const waitingEvent = await ownerQuery<{ status: string; last_error: string }>("select status, last_error from private.provider_events where id = $1", [
        two!.id,
      ]);
      expect(waitingEvent).toEqual([{ status: "pending", last_error: "second_live_subscription" }]);
      // El siguiente intento (el sexto) ya ve a la otra viva: registra el cobro (el dinero entró), deja la segunda sin dar acceso y, pasado su tope, queda fallido.
      const again = await claim(second, two!.id);
      expect(again.outcome).toBe("claimed");
      const secondCharge = `ch_it112_${randomUUID().slice(0, 8)}`;
      expect(await apply(second, { id: two!.id, attempt: again.attempt! }, subscription(sub2, beto.id, "2026-10-01T16:00:07Z"), [payment(secondCharge, sub2)])).toEqual({
        outcome: "failed",
        code: "second_live_subscription",
      });
      expect(await ledgerOf(beto.id)).toMatchObject({ charges: 2, receipts: 2, live: 1 });
    } finally {
      await Promise.all([first, second].map((client) => client.query("rollback").catch(() => undefined)));
      await Promise.all([first, second].map((client) => client.end()));
    }
  });

  it("diez reenvíos del mismo aviso a la vez lo reclaman una sola vez", async () => {
    const event = `${PREFIX}${randomUUID()}`;
    const clients = await Promise.all(Array.from({ length: CALLERS + 1 }, () => connect()));
    try {
      for (const client of clients) await asServerSystem(client);
      const stored = await Promise.all(clients.map((client) => receive(client, event, `in_${event}`)));
      expect(stored.filter((answer) => answer.outcome === "stored")).toHaveLength(1);
      expect(stored.filter((answer) => answer.outcome === "duplicate")).toHaveLength(CALLERS);
      expect(new Set(stored.map((answer) => answer.id)).size).toBe(1);
      const claims = await Promise.all(clients.map((client) => claim(client, stored[0]!.id)));
      expect(claims.filter((answer) => answer.outcome === "claimed")).toEqual([
        { outcome: "claimed", attempt: 1, event_type: "invoice.paid", object_id: `in_${event}`, id: stored[0]!.id, occurred_at: expect.any(String) },
      ]);
      expect(claims.filter((answer) => answer.outcome === "busy")).toHaveLength(CALLERS);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
});
