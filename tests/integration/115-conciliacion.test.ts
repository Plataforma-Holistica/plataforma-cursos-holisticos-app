import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { StripeAnswer, StripeGet } from "@/adapters/stripe/api";
import type { Tx } from "@/adapters/supabase/db";
import type { FailureCode } from "@/services/error-reporting/server";
import { createReconciliation, type ReconcileStore } from "@/services/billing/reconcile";
import {
  askReconcileExplain,
  askReconcileRecord,
  askReconcileWindow,
  askSettlementComplete,
  askSettlementsMissing,
} from "@/services/billing/records";

import { connect } from "./helpers/finance";
import { asSystem, reverted } from "./helpers/team";
import { ownerQuery } from "./helpers/users";

// La conciliación con Stripe de punta a punta, contra la base local (T-303, cuarta solicitud; RF-208, RF-501): el servicio lista un Stripe simulado por días y
// páginas, la base clasifica y compara con el libro de verdad, y lo que liquidó Stripe se completa. Cada caso corre en una transacción del dueño que se revierte,
// salvo el de las dos conexiones, que confirma un cobro y lo quita al terminar. Las reglas de la comparación las prueba `87_conciliacion`; las del servicio,
// `src/services/billing/reconcile.test.ts`.

const PERIOD = 202_610;
const TAG = randomUUID().slice(0, 8);
const committed: { profile: string; charge: string }[] = [];
let openedOctober = false;

afterAll(async () => {
  for (const { profile, charge } of committed) {
    await ownerQuery(
      `do $$ begin
         set local session_replication_role = replica;
         delete from private.provider_settlements where charge_id in (select id from public.charges where provider_charge_id = '${charge}');
         delete from public.revenue_allocations where charge_id in (select id from public.charges where provider_charge_id = '${charge}');
         delete from public.charges where provider_charge_id = '${charge}';
         delete from public.subscriptions where profile_id = '${profile}';
         delete from public.profiles where id = '${profile}';
         delete from auth.users where id = '${profile}';
       end $$`,
    );
  }
  // Octubre, si lo abrió esta prueba y ya nada lo nombra (como la 112 a la 114).
  if (openedOctober) {
    await ownerQuery(
      `begin;
       alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
       delete from public.payout_periods p where p.period_id = ${PERIOD}
         and not exists (select 1 from public.charges c where c.allocation_start_period_id = p.period_id);
       alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
       commit;`,
    );
  }
});

/** Las consultas de la aplicación sobre esa transacción, como sistema. */
function storeOn(owner: Client, due: number[] = [PERIOD]): ReconcileStore {
  const tx: Tx = {
    query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
  };
  const run = async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    await asSystem(owner);
    return work(tx);
  };
  return {
    window: (_actor, period) => run((t) => askReconcileWindow(t, period)),
    record: (_actor, period, livemode, startsAt, endsAt, complete, charges) =>
      run((t) => askReconcileRecord(t, period, livemode, startsAt, endsAt, complete, charges)),
    due: () => Promise.resolve(due),
    settlementsMissing: (_actor, period) => run((t) => askSettlementsMissing(t, period)),
    completeSettlement: (_actor, settlement) => run((t) => askSettlementComplete(t, settlement)),
    explain: (_claims, explanation) => run((t) => askReconcileExplain(t, explanation)),
  };
}

interface FakeCharge {
  id: string;
  created: number;
  cents: number;
  status?: string;
  captured?: boolean;
  livemode?: boolean;
}

/** Un Stripe simulado: devuelve lo que cae en cada ventana, de dos en dos, con `has_more`; y repite el primero de la página siguiente si se le pide. */
function fakeStripe(charges: FakeCharge[], options: { repeat?: boolean; settled?: Record<string, { fee: number }> } = {}): { get: StripeGet; pages: number } {
  const state = { pages: 0 };
  const shape = (c: FakeCharge) => ({
    id: c.id,
    object: "charge",
    status: c.status ?? "succeeded",
    captured: c.captured ?? true,
    currency: "mxn",
    livemode: c.livemode ?? false,
    created: c.created,
    amount_captured: c.cents,
  });
  const get: StripeGet = (path, query = {}) => {
    const q = query as Record<string, string>;
    if (path.startsWith("/v1/charges/")) {
      const id = path.slice("/v1/charges/".length);
      const found = charges.find((c) => c.id === id);
      const fee = options.settled?.[id]?.fee;
      if (found === undefined) return Promise.resolve({ status: "not_found" } satisfies StripeAnswer);
      return Promise.resolve({
        status: "ok",
        body: {
          id,
          currency: "mxn",
          balance_transaction:
            fee === undefined ? null : { id: `txn_${id}`, amount: found.cents, fee, net: found.cents - fee, currency: "mxn", available_on: found.created + 7 * 86_400 },
        },
      } satisfies StripeAnswer);
    }
    state.pages += 1;
    const from = Number(q["created[gte]"]);
    const to = Number(q["created[lt]"]);
    // Del más nuevo al más viejo, como Stripe.
    const inside = charges.filter((c) => c.created >= from && c.created < to).sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
    const start = q.starting_after === undefined ? 0 : inside.findIndex((c) => c.id === q.starting_after) + (options.repeat === true ? 0 : 1);
    const page = inside.slice(start, start + 2);
    return Promise.resolve({ status: "ok", body: { object: "list", data: page.map(shape), has_more: start + 2 < inside.length } } satisfies StripeAnswer);
  };
  return {
    get,
    get pages() {
      return state.pages;
    },
  };
}

/** Lo propio de octubre como lo tiene el libro: cada cobro de Stripe con su instante y su monto. */
async function ledger(owner: Client): Promise<FakeCharge[]> {
  const rows = await owner.query<{ id: string; created: string; cents: string }>(
    `select provider_charge_id as id, extract(epoch from charged_at)::bigint::text as created, gross_cents::text as cents
     from public.charges where provider = 'stripe' and period_id = $1`,
    [PERIOD],
  );
  return rows.rows.map((r) => ({ id: r.id, created: Number(r.created), cents: Number(r.cents) }));
}

/** Una alumna con su suscripción de Stripe y su cobro de octubre, por la función del libro. */
async function charged(owner: Client, n: number, at: string, cents = 34_900): Promise<{ profile: string; charge: string }> {
  const profile = randomUUID();
  const charge = `ch_it115_${TAG}_${n}`;
  await owner.query("insert into auth.users (id, email) values ($1, $2)", [profile, `it115-${TAG}-${n}@prueba.test`]);
  await owner.query(
    "insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency) values (gen_random_uuid(), $1, 'stripe', $2, 'monthly', 'pending', 'MXN')",
    [profile, `sub_it115_${TAG}_${n}`],
  );
  const answer = await owner.query<{ r: { outcome: string } }>(
    `select private.record_charge($1, (select id from public.subscriptions where profile_id = $1), 'stripe', $2, null, 'monthly', $3::timestamptz, 'MXN', $4,
                                  null, null, 'card', 'MX', null) as r`,
    [profile, charge, at, cents],
  );
  expect(["recorded", "already_recorded"]).toContain(answer.rows[0]!.r.outcome);
  return { profile, charge };
}

function service(owner: Client, stripe: StripeGet, options: { live?: boolean; clock?: () => number; due?: number[] } = {}) {
  const reported: FailureCode[] = [];
  const reconciliation = createReconciliation(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: () => Promise.reject(new Error("aquí compara el sistema")),
      store: storeOn(owner, options.due),
      stripe: () => stripe,
      live: () => options.live ?? false,
      now: options.clock ?? (() => Date.now()),
    },
  );
  return { ...reconciliation, reported };
}

const last = async (owner: Client) =>
  (
    await owner.query<{ complete: boolean; own_count: number; provider_count: number; provider_pending: number; sides: string[] | null; current: boolean }>(
      `select r.complete, r.own_count, r.provider_count, r.provider_pending,
              (select array_agg(d.side || ':' || d.provider_charge_id order by d.side, d.provider_charge_id)
               from private.billing_reconciliation_differences d where d.reconciliation_id = r.id) as sides,
              private.billing_reconciliation_current($1) is not null as current
       from private.billing_reconciliations r where r.period_id = $1 order by r.registered_at desc, r.id desc limit 1`,
      [PERIOD],
    )
  ).rows[0]!;

describe("la conciliación contra la base", () => {
  it("lista octubre por días y páginas, sin repetir, y con lo mismo que el libro coincide; lo pendiente no deja coincidir", async () => {
    await reverted(async (owner) => {
      await asSystem(owner);
      await owner.query("select private.open_period($1)", [PERIOD]);
      await charged(owner, 1, "2026-10-01 00:00:00-06");
      await charged(owner, 2, "2026-10-15 12:00:00-06");
      await charged(owner, 3, "2026-10-15 12:00:01-06");
      await charged(owner, 4, "2026-10-15 12:00:02-06");
      await charged(owner, 5, "2026-10-31 23:59:59-06");
      const mine = await ledger(owner);
      // Un cargo pendiente del último segundo del mes: Stripe todavía no lo confirma.
      const pending: FakeCharge = { id: `ch_it115_${TAG}_oxxo`, created: mine.at(-1)!.created, cents: 34_900, status: "pending", captured: false };

      const withPending = fakeStripe([...mine, pending], { repeat: true });
      const first = service(owner, withPending.get);
      expect(await first.sweepReconciliations()).toBe(true);
      expect(first.reported).toEqual(["billing_reconciliation_mismatch"]);
      expect(await last(owner)).toMatchObject({ complete: true, own_count: mine.length, provider_count: mine.length, provider_pending: 1, sides: null, current: false });
      // 31 días, y el 15 en dos páginas (de dos en dos, con el repetido).
      expect(withPending.pages).toBeGreaterThanOrEqual(32);

      const confirmed = service(owner, fakeStripe(mine).get);
      expect(await confirmed.sweepReconciliations()).toBe(true);
      expect(confirmed.reported).toEqual([]);
      expect(await last(owner)).toMatchObject({ complete: true, provider_pending: 0, sides: null, current: true });
    });
  });

  it("lo que el libro no tiene, o con otro monto, queda como su diferencia", async () => {
    await reverted(async (owner) => {
      await asSystem(owner);
      await owner.query("select private.open_period($1)", [PERIOD]);
      await charged(owner, 1, "2026-10-10 12:00:00-06");
      const mine = await ledger(owner);
      const changed = mine.map((c) => (c.id === `ch_it115_${TAG}_1` ? { ...c, cents: 30_000 } : c));
      const extra: FakeCharge = { id: `ch_it115_${TAG}_panel`, created: changed[0]!.created + 60, cents: 50_000 };
      const run = service(owner, fakeStripe([...changed, extra]).get);
      await run.sweepReconciliations();
      expect((await last(owner)).sides).toEqual([`amount:ch_it115_${TAG}_1`, `only_provider:ch_it115_${TAG}_panel`]);
    });
  });

  it("con el tope de tiempo vencido a media lista, la comparación se registra incompleta y no coincide", async () => {
    await reverted(async (owner) => {
      await asSystem(owner);
      await owner.query("select private.open_period($1)", [PERIOD]);
      const mine = await ledger(owner);
      let reads = 0;
      // La primera lectura fija el tope; a la décima ya pasó.
      const run = service(owner, fakeStripe(mine).get, { clock: () => (reads++ < 10 ? 0 : 60_000) });
      await run.sweepReconciliations();
      expect(await last(owner)).toMatchObject({ complete: false, current: false });
    });
  });

  it("cargos de otro modo que la llave: la base los rechaza y se reporta", async () => {
    await reverted(async (owner) => {
      await asSystem(owner);
      await owner.query("select private.open_period($1)", [PERIOD]);
      await charged(owner, 1, "2026-10-10 12:00:00-06");
      const run = service(owner, fakeStripe(await ledger(owner)).get, { live: true });
      await run.sweepReconciliations();
      expect(run.reported).toEqual(["billing_reconciliation_rejected"]);
    });
  });

  it("completa lo que liquidó Stripe de los cobros que llegaron sin su transacción de saldo", async () => {
    await reverted(async (owner) => {
      await asSystem(owner);
      await owner.query("select private.open_period($1)", [PERIOD]);
      const { charge } = await charged(owner, 1, "2026-10-10 12:00:00-06");
      const run = service(owner, fakeStripe(await ledger(owner), { settled: { [charge]: { fee: 1_500 } } }).get);
      await run.sweepReconciliations();
      const rows = await owner.query<{ balance_transaction_id: string; gross_cents: string; fee_cents: string; net_cents: string }>(
        `select s.balance_transaction_id, s.gross_cents::text, s.fee_cents::text, s.net_cents::text
         from private.provider_settlements s join public.charges c on c.id = s.charge_id where c.provider_charge_id = $1`,
        [charge],
      );
      expect(rows.rows).toEqual([{ balance_transaction_id: `txn_${charge}`, gross_cents: "34900", fee_cents: "1500", net_cents: "33400" }]);
    });
  });
});

describe("con dos conexiones a la vez", () => {
  it("un cobro que entra mientras se compara deja la comparación sin vigencia al confirmarse", async () => {
    const writer = await connect();
    try {
      // Una cuenta confirmada, para que la otra conexión la vea; el cobro, todavía no.
      const profile = randomUUID();
      const charge = `ch_it115_${TAG}_carrera`;
      committed.push({ profile, charge });
      await ownerQuery("insert into auth.users (id, email) values ($1, $2)", [profile, `it115-${TAG}-carrera@prueba.test`]);
      await ownerQuery(
        "insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency) values (gen_random_uuid(), $1, 'stripe', $2, 'monthly', 'pending', 'MXN')",
        [profile, `sub_it115_${TAG}_carrera`],
      );
      openedOctober = (await ownerQuery<{ created: boolean }>("select set_config('app.actor_kind', 'system', false), private.open_period($1) as created", [PERIOD]))[0]!
        .created;
      await writer.query("begin");
      await writer.query("select set_config('app.actor_kind', 'system', true)");
      await writer.query(
        `select private.record_charge($1, (select id from public.subscriptions where profile_id = $1), 'stripe', $2, null, 'monthly', '2026-10-20 12:00-06',
                                      'MXN', 34900, null, null, 'card', 'MX', null)`,
        [profile, charge],
      );

      await reverted(async (owner) => {
        await asSystem(owner);
        // Lo que ve la comparación: el libro sin el cobro que no se ha confirmado, y Stripe igual.
        const run = service(owner, fakeStripe(await ledger(owner)).get);
        await run.sweepReconciliations();
        expect((await last(owner)).current).toBe(true);
        await writer.query("commit");
        // Ya confirmado, cuenta en lo propio: la comparación de antes deja de estar vigente.
        expect((await last(owner)).current).toBe(false);
      });
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await writer.end();
    }
  });
});
