import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, secondFactorFor, type KnownUser } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { asOwner, asSystem, reverted, teamStoreOn } from "./helpers/team";
import { totpCode } from "./helpers/totp";
import { completeAccountAsOwner, createTestUser, deleteTestUsers, deleteTestUsersByEmail, ownerQuery, type TestUser } from "./helpers/users";

// El ensayo y el cierre (T-602; RF-502, RF-503, RN-09) contra la base local, en lo que una transacción
// revertida no puede mostrar: dos cierres a la vez, el cierre contra una escritura en vuelo de su
// entrada, el ensayo contra el cierre, y la comprobación al confirmar de verdad (en pgTAP nada confirma).
//
// Quien ensaya y cierra es alguien de finanzas de verdad: su segundo factor y su sesión los da el Auth
// local, y su código se da una vez al empezar, dentro de una transacción que se revierte. Su capacidad
// y su factor atado se escriben en cada transacción que ensaya o cierra con la sesión en réplica (sin
// auditoría ni guardias) y se quitan igual antes de confirmar: dar capacidades queda en la auditoría, y
// las pruebas de base cuentan esos renglones. Lo que el cierre escribe sí queda en la auditoría.
//
// Usa meses de 2036, que ninguna otra prueba usa, y el cierre va en orden desde el arranque: antes de
// empezar quita las filas abiertas desde el arranque a las que nada apunta (las abre cada noche el paso
// a cierre del `pg_cron` local, que las vuelve a abrir), y exige que no quede ninguna otra abierta o en
// cierre (si no, `pnpm db:reset`). Al terminar quita lo suyo con las guardias apagadas.

const FIRST = 203601;
const OURS = [203601, 203602, 203603, 203604, 203605, 203606, 203607];

interface Finance {
  person: KnownUser;
  factorId: string;
  sessionId: string;
}

let owner: Client;
let financeA: Finance;
let financeB: Finance;
let student: TestUser;
let subscription: string;
const emails: string[] = [];

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  await client.query("set lock_timeout = '20s'");
  return client;
}

/** Espera a que `count` conexiones estén detenidas por la de `first`. */
async function waitBehind(first: Client, count: number): Promise<void> {
  const pid = (await first.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const deadline = Date.now() + 4_000;
  for (;;) {
    const rows = await owner.query<{ waiting: number }>(
      "select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))",
      [pid],
    );
    if ((rows.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error("La otra conexión no llegó a esperar.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Alguien de finanzas, de verdad, con su código dado hace un momento. */
async function financePerson(): Promise<Finance> {
  const person = await claimedUser();
  emails.push(person.email);
  await completeAccountAsOwner(person.id);
  const factor = await secondFactorFor(person);
  const jar = memoryJar();
  const entered = await testServices().signIn(jar, person, freshOrigin());
  if (entered.kind !== "entered") throw new Error(`La persona de prueba no entró: ${entered.kind}`);
  const sessionId = await reverted(async (tx) => {
    const services = testServices({ teamStore: teamStoreOn(tx) });
    await asSystem(tx);
    await tx.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'finance')", [person.id]);
    await tx.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
      person.id,
      factor.factorId,
      person.email.toLowerCase(),
    ]);
    await asOwner(tx);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    const standing = await services.teamStanding(jar);
    if (standing.kind !== "team" || !standing.claims.sessionId) throw new Error("La persona de prueba no quedó en el equipo.");
    return standing.claims.sessionId;
  });
  return { person, factorId: factor.factorId, sessionId };
}

/** En esta transacción, la persona es de finanzas y actúa con su sesión. */
async function actAs(client: Client, finance: Finance): Promise<void> {
  await client.query("set local session_replication_role = replica");
  await client.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'finance')", [finance.person.id]);
  await client.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
    finance.person.id,
    finance.factorId,
    finance.person.email.toLowerCase(),
  ]);
  await client.query("set local session_replication_role = origin");
  await client.query("select set_config('app.actor_id', $1, true), set_config('app.actor_session', $2, true)", [
    finance.person.id,
    finance.sessionId,
  ]);
}

/** Antes de confirmar: se quita lo que `actAs` puso, sin dejarlo en la auditoría. */
async function retire(client: Client, finance: Finance): Promise<void> {
  await client.query("set local session_replication_role = replica");
  await client.query("delete from private.admin_factors where profile_id = $1", [finance.person.id]);
  await client.query("delete from public.admin_capabilities where profile_id = $1", [finance.person.id]);
  await client.query("set local session_replication_role = origin");
}

const outcomeOf = async (client: Client, call: string, period: number) =>
  (await client.query<{ r: Record<string, unknown> }>(`select private.${call}($1) as r`, [period])).rows[0]!.r;

/** Un ensayo confirmado de finanzas. */
async function rehearse(period: number, finance = financeA): Promise<Record<string, unknown>> {
  const client = await connect();
  try {
    await client.query("begin");
    await actAs(client, finance);
    const result = await outcomeOf(client, "rehearse_close", period);
    await retire(client, finance);
    await client.query("commit");
    return result;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

/** Un cierre confirmado de finanzas: la comprobación corre al confirmar. */
async function close(period: number, finance = financeA): Promise<Record<string, unknown>> {
  const client = await connect();
  try {
    await client.query("begin");
    await actAs(client, finance);
    const result = await outcomeOf(client, "close_period", period);
    await retire(client, finance);
    await client.query("commit");
    return result;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

/**
 * Un cobro mensual de 349.00 en un periodo, escrito a mano como lo escribiría `record_charge`, sin
 * confirmar: su parte toma candado compartido sobre la fila del periodo, como un cobro de verdad.
 */
async function chargeIn(client: Client, period: number): Promise<void> {
  const id = randomUUID();
  await client.query(
    `insert into public.charges (id, profile_id, subscription_id, provider, provider_charge_id, plan, charged_at, period_id,
                                 allocation_start_period_id, currency, gross_cents, tax_cents, fx_rate_to_mxn, fx_source, gross_mxn_cents,
                                 net_of_tax_mxn_cents, iva_bps, fee_bps, revenue_net_mxn_cents, payment_method, country_code)
     values ($1, $2, $3, 'manual', $4, 'monthly', now(), $5, $5, 'MXN', 34900, 4814, 1, 'same_currency', 34900, 30086, 1600, 500, 28581,
             'card', 'MX')`,
    [id, student.id, subscription, `it-${id}`, period],
  );
  await client.query(
    `insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
     values ($1, $2, $3, 'charge', 1, 1, 28581, 500, 'charge_date_v1')`,
    [id, student.id, period],
  );
}

beforeAll(async () => {
  owner = await connect();
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2036 en la base local: pnpm db:reset");
  await owner.query("begin");
  await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
  await owner.query(
    `delete from public.payout_periods p
     where p.status = 'open' and p.period_id < $1
       and p.period_id >= (select min(effective_period_id) from public.pool_tiers where canceled_at is null)
       and not exists (select 1 from public.charges c where c.allocation_start_period_id = p.period_id)
       and not exists (select 1 from public.watch_rollup w where w.period_id = p.period_id)
       and not exists (select 1 from public.anomaly_alerts a where a.period_id = p.period_id)
       and not exists (select 1 from public.consumption_exclusions x where x.period_id = p.period_id)
       and not exists (select 1 from public.close_runs r where r.period_id = p.period_id)`,
    [FIRST],
  );
  await owner.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
  await owner.query("commit");
  const before = await owner.query(
    `select period_id from public.payout_periods
     where status in ('open', 'closing') and period_id < $1
       and period_id >= (select min(effective_period_id) from public.pool_tiers where canceled_at is null)`,
    [FIRST],
  );
  if ((before.rowCount ?? 0) > 0) throw new Error("hay periodos abiertos desde el arranque en la base local: pnpm db:reset");

  financeA = await financePerson();
  financeB = await financePerson();
  student = await createTestUser();
  subscription = randomUUID();
  await ownerQuery(
    `insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
     values ($1, $2, 'manual', $3, 'monthly', 'pending', 'MXN')`,
    [subscription, student.id, `it-${subscription}`],
  );

  // Los meses, en cierre y con su foto, y una consolidación completa correcta de cada uno.
  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
  for (const period of OURS) await owner.query("select private.open_period($1)", [period]);
  await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
  await owner.query(
    `update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 1, pool_bps = 6000
     where period_id = any($1::int[]) and period_id < 203607`,
    [OURS],
  );
  await owner.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
  await owner.query(
    `insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
     select 'nightly_rollup', p, 'succeeded', now() - interval '1 hour', now() - interval '1 hour', now() - interval '59 minutes', '{"mode": "full"}'
     from unnest($1::int[]) p`,
    [OURS],
  );
  await owner.query("commit");
});

afterAll(async () => {
  await owner.query("begin");
  try {
    await owner.query("set local session_replication_role = replica");
    await owner.query(
      "delete from public.payout_status_events where payout_id in (select id from public.payouts where period_id = any($1::int[]))",
      [OURS],
    );
    await owner.query("delete from public.payouts where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.bonuses where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_shares where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_student_pools where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_teacher_totals where period_id = any($1::int[])", [OURS]);
    await owner.query("update public.payout_periods set close_run_id = null where period_id = any($1::int[])", [OURS]);
    await owner.query(
      "delete from public.close_run_teacher_totals where close_run_id in (select id from public.close_runs where period_id = any($1::int[]))",
      [OURS],
    );
    await owner.query("delete from public.close_runs where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.job_runs where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.revenue_allocations where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.charges where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_periods where period_id = any($1::int[])", [OURS]);
    await owner.query("set local session_replication_role = origin");
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
  if (student) await deleteTestUsers([student]);
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
  await owner.end();
});

describe("el cierre, de verdad", () => {
  it("fuera de read committed no se ensaya ni se cierra", async () => {
    const client = await connect();
    try {
      for (const call of ["rehearse_close", "close_period"]) {
        await client.query("begin isolation level repeatable read");
        await actAs(client, financeA);
        await expect(outcomeOf(client, call, FIRST)).rejects.toMatchObject({ code: "25000" });
        await client.query("rollback");
      }
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  });

  it("dos cierres a la vez: uno cierra, el otro espera y contesta con ese cierre; la comprobación pasa al confirmar", async () => {
    expect((await rehearse(203601)).outcome).toBe("rehearsed");
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      await actAs(first, financeA);
      const closed = await outcomeOf(first, "close_period", 203601);
      expect(closed.outcome).toBe("closed");
      await second.query("begin");
      await actAs(second, financeB);
      const waiting = outcomeOf(second, "close_period", 203601);
      await waitBehind(first, 1);
      await retire(first, financeA);
      await first.query("commit");
      expect(await waiting).toEqual({ outcome: "already_closed", close_run_id: closed.close_run_id });
      await second.query("rollback");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      await Promise.all([first, second].map((client) => client.end()));
    }
    const rows = await ownerQuery<{ status: string; runs: number; by: string }>(
      `select p.status::text as status, p.closed_by::text as by,
              (select count(*)::int from public.close_runs r where r.period_id = p.period_id and r.kind = 'close') as runs
       from public.payout_periods p where p.period_id = 203601`,
    );
    expect(rows[0]).toEqual({ status: "closed", runs: 1, by: financeA.person.id });
  });

  it("un cobro en vuelo: el cierre lo espera, ve la entrada cambiada y pide otro ensayo", async () => {
    expect((await rehearse(203602)).outcome).toBe("rehearsed");
    const writer = await connect();
    const closer = await connect();
    try {
      await writer.query("begin");
      await chargeIn(writer, 203602);
      await closer.query("begin");
      await actAs(closer, financeA);
      const waiting = outcomeOf(closer, "close_period", 203602);
      await waitBehind(writer, 1);
      await writer.query("commit");
      expect((await waiting).outcome).toBe("rehearsal_stale");
      await closer.query("rollback");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await closer.query("rollback").catch(() => undefined);
      await Promise.all([writer, closer].map((client) => client.end()));
    }
    expect((await rehearse(203602)).outcome).toBe("rehearsed");
    const closed = await close(203602);
    // Nadie tuvo puntos: el bote del cobro (171.48) pasa entero al siguiente.
    expect([closed.outcome, closed.net_revenue_cents, closed.pool_cents, closed.carried_out_cents, closed.carried_to]).toEqual([
      "closed",
      28581,
      17148,
      17148,
      203603,
    ]);
  });

  it("un cobro y un ensayo que llegan mientras se cierra esperan y lo encuentran cerrado", async () => {
    expect((await rehearse(203603)).outcome).toBe("rehearsed");
    const closer = await connect();
    const writer = await connect();
    const rehearsing = await connect();
    try {
      await closer.query("begin");
      await actAs(closer, financeA);
      const closed = await outcomeOf(closer, "close_period", 203603);
      expect(closed.outcome).toBe("closed");
      await writer.query("begin");
      const attempt = chargeIn(writer, 203603).then(
        () => "entró",
        (error: { code?: string }) => error.code,
      );
      await rehearsing.query("begin");
      await actAs(rehearsing, financeB);
      const late = outcomeOf(rehearsing, "rehearse_close", 203603);
      await waitBehind(closer, 2);
      await retire(closer, financeA);
      await closer.query("commit");
      expect(await attempt).toBe("55000");
      expect(await late).toEqual({ outcome: "already_closed", close_run_id: closed.close_run_id });
      await writer.query("rollback");
      await rehearsing.query("rollback");
    } finally {
      await closer.query("rollback").catch(() => undefined);
      await writer.query("rollback").catch(() => undefined);
      await rehearsing.query("rollback").catch(() => undefined);
      await Promise.all([closer, writer, rehearsing].map((client) => client.end()));
    }
    const rows = await ownerQuery<{ carried_in: string; pool: string }>(
      "select carried_in_cents::text as carried_in, pool_cents::text as pool from public.payout_periods where period_id = 203603",
    );
    expect(rows[0]).toEqual({ carried_in: "17148", pool: "17148" });
  });

  it("el cierre espera al ensayo en vuelo, y con él confirmado, cierra", async () => {
    const rehearsing = await connect();
    const closer = await connect();
    try {
      await rehearsing.query("begin");
      await actAs(rehearsing, financeB);
      expect((await outcomeOf(rehearsing, "rehearse_close", 203604)).outcome).toBe("rehearsed");
      await closer.query("begin");
      await actAs(closer, financeA);
      const waiting = outcomeOf(closer, "close_period", 203604);
      await waitBehind(rehearsing, 1);
      await retire(rehearsing, financeB);
      await rehearsing.query("commit");
      expect((await waiting).outcome).toBe("closed");
      await retire(closer, financeA);
      await closer.query("commit");
    } finally {
      await rehearsing.query("rollback").catch(() => undefined);
      await closer.query("rollback").catch(() => undefined);
      await Promise.all([rehearsing, closer].map((client) => client.end()));
    }
  });

  it("un ensayo que no vio una escritura en vuelo no sirve para cerrar", async () => {
    const writer = await connect();
    try {
      await writer.query("begin");
      await chargeIn(writer, 203605);
      // El ensayo toma la fila compartida, como el cobro: no se esperan, y el ensayo no ve el cobro.
      const blind = await rehearse(203605);
      expect([blind.outcome, blind.net_revenue_cents]).toEqual(["rehearsed", 0]);
      await writer.query("commit");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await writer.end();
    }
    expect((await close(203605)).outcome).toBe("rehearsal_stale");
    const seen = await rehearse(203605);
    expect([seen.outcome, seen.net_revenue_cents]).toEqual(["rehearsed", 28581]);
    expect((await close(203605)).outcome).toBe("closed");
  });

  it("y en orden: diciembre de 2036 no se cierra con un mes anterior en cierre", async () => {
    expect(await close(203607)).toEqual({ outcome: "not_closing" });
    expect((await rehearse(203606)).outcome).toBe("rehearsed");
    const skipped = await connect();
    try {
      await skipped.query("begin");
      await skipped.query("select set_config('app.actor_kind', 'system', true)");
      await skipped.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
      await skipped.query("update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 1, pool_bps = 6000 where period_id = 203607");
      await skipped.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
      await skipped.query("commit");
    } finally {
      await skipped.query("rollback").catch(() => undefined);
      await skipped.end();
    }
    expect(await close(203607)).toEqual({ outcome: "previous_not_closed", period: 203606 });
    expect((await close(203606)).outcome).toBe("closed");
  });
});
