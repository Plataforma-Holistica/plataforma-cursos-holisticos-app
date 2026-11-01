import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  actAs,
  asFinance,
  clearPeriodsBefore,
  connect,
  financePerson,
  outcomeOf,
  zeroWithholding,
  retire,
  waitBehind,
  type Finance,
} from "./helpers/finance";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Liberar las liquidaciones (T-603; RF-505 a RF-508) contra la base local, en lo que una transacción
// revertida no puede mostrar: liberar a la vez que otra liberación, que un bono a mano, que una
// anulación o que una retención, liberar el mes siguiente mientras se libera uno, y la comprobación de
// cada liberación al confirmar de verdad. Quien libera es alguien de finanzas de verdad (`helpers/finance`).
//
// Usa meses de 2037, que ninguna otra prueba usa, y un maestro sin curso: sus liquidaciones nacen de los
// bonos a mano. El mínimo es el de la semilla (500 MXN). Antes de empezar quita las filas abiertas desde
// el arranque a las que nada apunta, y exige que no quede ninguna otra abierta, en cierre o sin liberar;
// cierra sus meses de verdad, en orden. Al terminar quita lo suyo con las guardias apagadas; la auditoría
// se queda.

const FIRST = 203701;
const OURS = [203701, 203702, 203703, 203704, 203705, 203706, 203707];

let owner: Client;
let financeA: Finance;
let financeB: Finance;
let teacher: string;
const emails: string[] = [];

const call = async (client: Client, sql: string, args: unknown[]) =>
  (await client.query<{ r: Record<string, unknown> }>(`select ${sql} as r`, args)).rows[0]!.r;

const bonus = (amount: number, period: number, finance = financeA) =>
  asFinance(finance, (client) =>
    call(client, "private.capture_bonus($1, 'discretionary', $2, $3, 'Bono de la prueba.')", [teacher, amount, period]),
  );

const payoutOf = async (period: number) =>
  (await owner.query<{ id: string; status: string; subtotal: string }>(
    "select id::text, status::text, subtotal_cents::text as subtotal from public.payouts where period_id = $1 and teacher_id = $2",
    [period, teacher],
  )).rows[0];

beforeAll(async () => {
  owner = await connect();
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2037 en la base local: pnpm db:reset");
  await clearPeriodsBefore(owner, FIRST);

  financeA = await financePerson(emails);
  financeB = await financePerson(emails);
  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
  teacher = (await owner.query<{ id: string }>("insert into public.teachers (status) values ('invited') returning id::text")).rows[0]!.id;
  await zeroWithholding(owner, teacher, financeA.person.id);
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
  // Los meses, cerrados de verdad y en orden: sin consumo, todo pasa al siguiente.
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
    await owner.query("delete from public.payout_periods where period_id = any($1::int[]) or period_id = 203708", [OURS]);
    await owner.query("delete from private.teacher_tax_profiles where teacher_id = $1", [teacher]);
    await owner.query("delete from public.withholding_rules where note = 'regla en 0 de las pruebas'");
    // Lo demás de la auditoría se queda, como en la 58; este renglón no: las pruebas de base cuentan los de las reglas.
    await owner.query("delete from public.audit_log where action = 'withholding_rules.insert'");
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

describe("liberar, de verdad", () => {
  it("fuera de read committed no se libera", async () => {
    const client = await connect();
    try {
      await client.query("begin isolation level repeatable read");
      await actAs(client, financeA);
      await expect(outcomeOf(client, "release_payouts", FIRST)).rejects.toMatchObject({ code: "25000" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  });

  it("dos liberaciones a la vez: una libera, la otra espera y contesta que ya está; la comprobación pasa al confirmar", async () => {
    expect((await bonus(60000, 203701)).outcome).toBe("captured");
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      await actAs(first, financeA);
      expect((await outcomeOf(first, "release_payouts", 203701)).outcome).toBe("released");
      await second.query("begin");
      await actAs(second, financeB);
      const waiting = outcomeOf(second, "release_payouts", 203701);
      await waitBehind(owner, first, 1);
      await retire(first, financeA);
      await first.query("commit");
      expect(await waiting).toEqual({ outcome: "already_released", period_id: 203701 });
      await retire(second, financeB);
      await second.query("commit");
    } finally {
      for (const client of [first, second]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    expect(await payoutOf(203701)).toMatchObject({ status: "awaiting_invoice", subtotal: "60000" });
  });

  it("un bono que llega mientras se libera su mes espera, y va al mes siguiente", async () => {
    expect((await bonus(1000, 203702)).outcome).toBe("captured");
    const releaser = await connect();
    const capturer = await connect();
    try {
      await releaser.query("begin");
      await actAs(releaser, financeA);
      expect((await outcomeOf(releaser, "release_payouts", 203702)).outcome).toBe("released");
      await capturer.query("begin");
      await actAs(capturer, financeB);
      const waiting = call(capturer, "private.capture_bonus($1, 'discretionary', 2000, 203702, 'Tarde.')", [teacher]);
      await waitBehind(owner, releaser, 1);
      await retire(releaser, financeA);
      await releaser.query("commit");
      expect(await waiting).toMatchObject({ outcome: "captured", period_id: 203703, moved: true });
      await retire(capturer, financeB);
      await capturer.query("commit");
    } finally {
      for (const client of [releaser, capturer]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    // 10.00 no llega al mínimo: queda acumulado.
    expect(await payoutOf(203702)).toMatchObject({ status: "carried_forward", subtotal: "1000" });
  });

  it("una anulación que llega mientras se libera su mes espera, y ya no anula", async () => {
    const captured = await bonus(70000, 203703);
    const releaser = await connect();
    const voider = await connect();
    try {
      await releaser.query("begin");
      await actAs(releaser, financeA);
      expect((await outcomeOf(releaser, "release_payouts", 203703)).outcome).toBe("released");
      await voider.query("begin");
      await actAs(voider, financeB);
      const waiting = call(voider, "private.void_bonus($1, 'Se capturó mal.')", [captured.bonus_id]);
      await waitBehind(owner, releaser, 1);
      await retire(releaser, financeA);
      await releaser.query("commit");
      expect(await waiting).toEqual({ outcome: "period_released" });
      await retire(voider, financeB);
      await voider.query("commit");
    } finally {
      for (const client of [releaser, voider]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    // Los dos bonos de marzo (el tardío de febrero y este) más los 10.00 acumulados.
    expect(await payoutOf(203703)).toMatchObject({ status: "awaiting_invoice", subtotal: "73000" });
  });

  // Cambió con el requisito (T-605, cuarta solicitud): retener lleva el estado que se vio. Antes la retención
  // que esperaba retenía lo ya liberado; ahora quien la pidió se entera de que ya se liberó.
  it("una retención que llega mientras se libera espera, y dice que ya se liberó; con el estado de ahora retiene, y al soltarla vuelve a donde estaba", async () => {
    expect((await bonus(80000, 203704)).outcome).toBe("captured");
    const payout = (await payoutOf(203704))!.id;
    const releaser = await connect();
    const holder = await connect();
    try {
      await releaser.query("begin");
      await actAs(releaser, financeA);
      expect((await outcomeOf(releaser, "release_payouts", 203704)).outcome).toBe("released");
      await holder.query("begin");
      await actAs(holder, financeB);
      const waiting = call(holder, "private.hold_payout($1, 'Se investiga.', 'calculated')", [payout]);
      await waitBehind(owner, releaser, 1);
      await retire(releaser, financeA);
      await releaser.query("commit");
      expect(await waiting).toEqual({ outcome: "changed", status: "awaiting_invoice" });
      expect(await call(holder, "private.hold_payout($1, 'Se investiga.', 'awaiting_invoice')", [payout])).toEqual({
        outcome: "held",
        from: "awaiting_invoice",
      });
      await retire(holder, financeB);
      await holder.query("commit");
    } finally {
      for (const client of [releaser, holder]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    expect(await asFinance(financeA, (client) => call(client, "private.unhold_payout($1, 'Todo en orden.', private.unhold_preview($1) ->> 'fingerprint')", [payout]))).toEqual({
      outcome: "released_from_hold",
      to: "awaiting_invoice",
      period_status: "closed",
    });
  });

  it("dos bonos a la vez para un maestro sin liquidación en un mes cerrado: nace una sola, y los dos se capturan", async () => {
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      await actAs(first, financeA);
      expect(await call(first, "private.capture_bonus($1, 'discretionary', 1000, 203707, 'Uno.')", [teacher])).toMatchObject({
        outcome: "captured",
        period_id: 203707,
      });
      await second.query("begin");
      await actAs(second, financeB);
      const waiting = call(second, "private.capture_bonus($1, 'discretionary', 2000, 203707, 'Dos.')", [teacher]);
      await waitBehind(owner, first, 1);
      await retire(first, financeA);
      await first.query("commit");
      expect(await waiting).toMatchObject({ outcome: "captured", period_id: 203707 });
      await retire(second, financeB);
      await second.query("commit");
    } finally {
      for (const client of [first, second]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    const payouts = await owner.query("select 1 from public.payouts where period_id = 203707 and teacher_id = $1", [teacher]);
    expect(payouts.rowCount).toBe(1);
  });

  it("el mes siguiente no se libera mientras uno anterior se está liberando: contesta sin esperar", async () => {
    const first = await connect();
    try {
      await first.query("begin");
      await actAs(first, financeA);
      expect((await outcomeOf(first, "release_payouts", 203705)).outcome).toBe("released");
      const next = await asFinance(financeB, (client) => outcomeOf(client, "release_payouts", 203706));
      expect(next).toEqual({ outcome: "previous_not_released", period: 203705 });
      await retire(first, financeA);
      await first.query("commit");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await first.end();
    }
    // Sin liquidaciones, abril pasa a pagado al liberarse.
    const status = await owner.query<{ status: string }>("select status::text from public.payout_periods where period_id = 203705");
    expect(status.rows[0]?.status).toBe("paid");
  });

  it("una liberación que no cuadra no se guarda: la comprobación corre al confirmar", async () => {
    expect((await bonus(90000, 203706)).outcome).toBe("captured");
    const client = await connect();
    try {
      await client.query("begin");
      await actAs(client, financeA);
      expect((await outcomeOf(client, "release_payouts", 203706)).outcome).toBe("released");
      await client.query("set local session_replication_role = replica");
      await client.query(
        `update public.payouts set bonuses_cents = bonuses_cents + 1, subtotal_cents = subtotal_cents + 1, net_cents = net_cents + 1
         where period_id = 203706 and teacher_id = $1`,
        [teacher],
      );
      await client.query("set local session_replication_role = origin");
      await retire(client, financeA);
      await expect(client.query("commit")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
    const released = await owner.query<{ at: string | null }>(
      "select payouts_released_at::text as at from public.payout_periods where period_id = 203706",
    );
    expect(released.rows[0]?.at).toBeNull();
    expect((await asFinance(financeA, (client) => outcomeOf(client, "release_payouts", 203706))).outcome).toBe("released");
  });
});
