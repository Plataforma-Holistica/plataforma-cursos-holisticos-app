import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actAs, asFinance, clearPeriodsBefore, connect, financePerson, outcomeOf, retire, waitBehind, type Finance } from "./helpers/finance";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// PA-81 (T-605, cuarta solicitud) contra la base local, en lo que una transacción revertida no puede mostrar: que
// liberar no escribe algo distinto de lo que se vio cuando, entre ver y confirmar, otra persona suelta una
// retenida de un periodo anterior y con eso mueve el saldo del maestro. Liberar toma los candados de saldo de sus
// maestros antes de recalcular la vista, y soltar toma el suyo: el segundo espera al primero, y quien llega tarde
// se entera de que cambió. Quien libera y quien suelta son personas de finanzas de verdad (`helpers/finance`).
//
// Usa meses de 2041, que ninguna otra prueba usa, y un maestro sin curso: sus liquidaciones nacen de los bonos a
// mano. El mínimo es el de la semilla (500 MXN), así que todo se acumula. Como la 55, quita antes las filas
// abiertas desde el arranque a las que nada apunta, cierra sus meses de verdad, en orden, y al terminar quita lo
// suyo con las guardias apagadas; la auditoría se queda.

const FIRST = 204101;
const OURS = [204101, 204102, 204103, 204104];

let owner: Client;
let financeA: Finance;
let financeB: Finance;
let teacher: string;
const emails: string[] = [];

const call = async (client: Client, sql: string, args: unknown[]) =>
  (await client.query<{ r: Record<string, unknown> }>(`select ${sql} as r`, args)).rows[0]!.r;

const payoutOf = async (period: number) =>
  (await owner.query<{ id: string; status: string; subtotal: string }>(
    "select id::text, status::text, subtotal_cents::text as subtotal from public.payouts where period_id = $1 and teacher_id = $2",
    [period, teacher],
  )).rows[0];

/** Lo que PA-81 trae: la huella de liberar el periodo, y la de soltar cada retenida. */
const seen = (period: number) =>
  asFinance(financeA, async (client) => (await call(client, "private.finance_payouts($1)", [period])) as { release: { fingerprint: string } | null; payouts: { payout_id: string; unhold_fingerprint: string | null }[] });

beforeAll(async () => {
  owner = await connect();
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2041 en la base local: pnpm db:reset");
  await clearPeriodsBefore(owner, FIRST);

  financeA = await financePerson(emails);
  financeB = await financePerson(emails);
  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
  teacher = (await owner.query<{ id: string }>("insert into public.teachers (status) values ('invited') returning id::text")).rows[0]!.id;
  for (const period of OURS) await owner.query("select private.open_period($1)", [period]);
  await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
  await owner.query(
    `update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 1, pool_bps = 6000
     where period_id = any($1::int[])`,
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
  for (const period of OURS) {
    await asFinance(financeA, (client) => outcomeOf(client, "rehearse_close", period));
    const closed = await asFinance(financeA, (client) => outcomeOf(client, "close_period", period));
    if (closed.outcome !== "closed") throw new Error(`no cerró ${period}: ${JSON.stringify(closed)}`);
  }
});

afterAll(async () => {
  await owner.query("begin");
  try {
    await owner.query("set local session_replication_role = replica");
    await owner.query("delete from public.teacher_balance_entries where teacher_id = $1", [teacher]);
    await owner.query("delete from public.payout_adjustments where teacher_id = $1", [teacher]);
    await owner.query(
      "delete from public.payout_status_events where payout_id in (select id from public.payouts where period_id = any($1::int[]))",
      [OURS],
    );
    await owner.query("delete from public.payouts where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.bonuses where period_id = any($1::int[])", [OURS]);
    await owner.query("update public.payout_periods set close_run_id = null where period_id = any($1::int[])", [OURS]);
    await owner.query(
      "delete from public.close_run_teacher_totals where close_run_id in (select id from public.close_runs where period_id = any($1::int[]))",
      [OURS],
    );
    await owner.query("delete from private.close_exports where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.close_runs where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.job_runs where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_periods where period_id = any($1::int[]) or period_id = 204105", [OURS]);
    await owner.query("delete from public.teachers where id = $1", [teacher]);
    await owner.query("set local session_replication_role = origin");
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
  await owner.end();
});


const bonus = (amount: number, period: number) =>
  asFinance(financeA, (client) => call(client, "private.capture_bonus($1, 'discretionary', $2, $3, 'Bono de la prueba.')", [teacher, amount, period]));
const hold = (payout: string) => asFinance(financeA, (client) => call(client, "private.hold_payout($1, 'Se investiga.', 'calculated')", [payout]));
const unholdSeen = async (period: number, payout: string) => (await seen(period)).payouts.find((row) => row.payout_id === payout)!.unhold_fingerprint!;

describe("liberar y soltar con lo que se vio, de verdad", () => {
  let january: string;
  let february: string;

  beforeAll(async () => {
    // Enero y febrero: un bono cada uno, retenido desde calculada, y el mes liberado con la retenida dentro.
    // Soltarlas las libera ahí mismo y las acumula (debajo de 500 MXN), y con eso mueve el saldo del maestro.
    for (const [period, amount] of [[204101, 1000], [204102, 1500]] as const) {
      expect((await bonus(amount, period)).outcome).toBe("captured");
      const payout = (await payoutOf(period))!.id;
      expect((await hold(payout)).outcome).toBe("held");
      expect((await asFinance(financeA, (client) => outcomeOf(client, "release_payouts", period))).outcome).toBe("released");
    }
    january = (await payoutOf(204101))!.id;
    february = (await payoutOf(204102))!.id;
  });

  it("soltar en un mes anterior mientras se libera el siguiente: liberar espera su candado, y como el saldo cambió, no libera", async () => {
    expect((await bonus(2000, 204103)).outcome).toBe("captured");
    const march = await seen(204103);
    const unhold = await unholdSeen(204101, january);

    const unholder = await connect();
    const releaser = await connect();
    try {
      await unholder.query("begin");
      await actAs(unholder, financeB);
      expect(await call(unholder, "private.unhold_payout($1, 'No era nada.', $2)", [january, unhold])).toEqual({
        outcome: "released_from_hold",
        to: "carried_forward",
        period_status: "paid",
      });
      await releaser.query("begin");
      await actAs(releaser, financeA);
      const waiting = call(releaser, "private.release_payouts($1, $2)", [204103, march.release!.fingerprint]);
      await waitBehind(owner, unholder, 1);
      await retire(unholder, financeB);
      await unholder.query("commit");
      expect(await waiting).toEqual({ outcome: "preview_changed" });
      await retire(releaser, financeA);
      await releaser.query("commit");
    } finally {
      for (const client of [unholder, releaser]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    // Sin liberar, lo escrito es solo lo del bote (aquí 0): el bono y el saldo se suman al liberar.
    expect(await payoutOf(204103)).toMatchObject({ status: "calculated", subtotal: "0" });
    // Con la vista de ahora, marzo se libera con el saldo de enero dentro.
    expect((await asFinance(financeA, (client) => outcomeOf(client, "release_payouts", 204103))).outcome).toBe("released");
    expect(await payoutOf(204103)).toMatchObject({ status: "carried_forward", subtotal: "3000" });
  });

  it("y al revés: soltar mientras se libera el siguiente espera su candado, y como el saldo cambió, no suelta", async () => {
    expect((await bonus(100, 204104)).outcome).toBe("captured");
    const april = await seen(204104);
    const unhold = await unholdSeen(204102, february);

    const releaser = await connect();
    const unholder = await connect();
    try {
      await releaser.query("begin");
      await actAs(releaser, financeA);
      expect(await call(releaser, "private.release_payouts($1, $2)", [204104, april.release!.fingerprint])).toMatchObject({ outcome: "released" });
      await unholder.query("begin");
      await actAs(unholder, financeB);
      const waiting = call(unholder, "private.unhold_payout($1, null, $2)", [february, unhold]);
      await waitBehind(owner, releaser, 1);
      await retire(releaser, financeA);
      await releaser.query("commit");
      expect(await waiting).toEqual({ outcome: "changed" });
      await retire(unholder, financeB);
      await unholder.query("commit");
    } finally {
      for (const client of [releaser, unholder]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    // Abril aplicó los 30.00 acumulados: 31.00, acumulada. Febrero sigue retenida.
    expect(await payoutOf(204104)).toMatchObject({ status: "carried_forward", subtotal: "3100" });
    expect(await payoutOf(204102)).toMatchObject({ status: "on_hold" });
    // Con la huella de ahora, febrero se suelta y se acumula con su saldo de 31.00: 46.00.
    const fresh = await unholdSeen(204102, february);
    expect(await asFinance(financeB, (client) => call(client, "private.unhold_payout($1, null, $2)", [february, fresh]))).toEqual({
      outcome: "released_from_hold",
      to: "carried_forward",
      period_status: "paid",
    });
    expect(await payoutOf(204102)).toMatchObject({ status: "carried_forward", subtotal: "4600" });
  });
});
