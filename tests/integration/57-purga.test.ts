import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect } from "./helpers/finance";

// La purga diaria de los latidos (T-603; 05 §11.4 y §13) de verdad: `private.raw_retention()` confirma
// periodo por periodo, así que en pgTAP no se puede llamar (`48_purga` prueba cada condición de la
// función que purga uno). Aquí: purga lo que toca, anota la corrida, y una partición que alguien tiene
// tomada no la espera más de 2 s: esa falla, la corrida lo dice, y las demás se purgan igual.
//
// Usa enero y febrero de 2033, que ninguna otra prueba usa, cerrados hace 100 días con su partición.

const OURS = [203301, 203302];
let owner: Client;
let started: string;

const partitionExists = async (period: number) =>
  (await owner.query<{ there: boolean }>("select to_regclass($1) is not null as there", [`public.watch_events_${period}`])).rows[0]!
    .there;

const lastRun = async () =>
  (await owner.query<{ status: string; details: { purged: number; skipped: number; failed: number }; error: string | null }>(
    "select status::text, details, error from public.job_runs where job = 'raw_retention' and started_at >= $1::timestamptz order by started_at desc limit 1",
    [started],
  )).rows[0];

beforeAll(async () => {
  owner = await connect();
  started = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2033 en la base local: pnpm db:reset");
  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
  for (const period of OURS) {
    await owner.query("select private.open_period($1)", [period]);
    await owner.query("select private.create_watch_partition($1)", [period]);
  }
  await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
  await owner.query(
    `update public.payout_periods set status = 'closed', entered_closing_at = now() - interval '101 days', closed_at = now() - interval '100 days'
     where period_id = any($1::int[])`,
    [OURS],
  );
  await owner.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
  await owner.query("commit");
});

afterAll(async () => {
  for (const period of OURS) await owner.query(`drop table if exists public.watch_events_${period}`);
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  await owner.query("delete from public.payout_periods where period_id = any($1::int[])", [OURS]);
  await owner.query("delete from public.job_runs where job = 'raw_retention' and started_at >= $1::timestamptz", [started]);
  await owner.query("set local session_replication_role = origin");
  await owner.query("commit");
  await owner.end();
});

describe("la purga diaria, de verdad", () => {
  it("purga lo que toca y no espera a una partición tomada: esa falla, la corrida lo dice, y las demás se purgan", async () => {
    const blocker = await connect();
    const runner = await connect();
    try {
      await blocker.query("begin");
      await blocker.query("lock table public.watch_events_203302 in access share mode");
      const before = Date.now();
      await runner.query("call private.raw_retention()");
      expect(Date.now() - before).toBeLessThan(15_000);
      expect(await partitionExists(203301)).toBe(false);
      expect(await partitionExists(203302)).toBe(true);
      const run = await lastRun();
      expect(run?.status).toBe("failed");
      expect(run?.details.failed).toBe(1);
      expect(run?.details.purged).toBeGreaterThanOrEqual(1);
      expect(run?.error).toMatch(/^203302: 55P03/);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      await blocker.end();
      await runner.end();
    }
  });

  it("al día siguiente, suelta, la purga y la corrida termina bien", async () => {
    const runner = await connect();
    try {
      await runner.query("call private.raw_retention()");
    } finally {
      await runner.end();
    }
    expect(await partitionExists(203302)).toBe(false);
    expect((await lastRun())?.status).toBe("succeeded");
  });
});
