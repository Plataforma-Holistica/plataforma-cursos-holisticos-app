import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actAs, clearPeriodsBefore, connect, financePerson, outcomeOf, retire, waitBehind, type Finance } from "./helpers/finance";
import { assertPlainWindow, dropTransitionLeftovers } from "./helpers/periods";
import { asOwner, asSystem } from "./helpers/team";
import { createTestUser, deleteTestUsers, deleteTestUsersByEmail, type TestUser } from "./helpers/users";

// El estimado del maestro (T-408, primera solicitud) contra la base local, en lo que una transacción revertida no puede mostrar. Dos partes.
//
// La corrida de verdad: `nightly_rollup` es un procedimiento con `commit`, y aquí corre como lo corre pg_cron, una llamada suelta del dueño. Cada
// periodo que consolidó deja su estimado en su propia corrida; un paso que falla no deja fallida la consolidación; un recálculo pedido también
// estima. Corre sobre el mes en curso de la base local, sin marcas, y al terminar quita lo que dejó.
//
// Y el congelado con dos conexiones: un cierre en vuelo y la escritura del estimado no se cruzan. Usa enero y febrero de 2046, que ninguna otra
// prueba usa, con un maestro, dos alumnos y su consumo escritos con las guardias apagadas; el cierre lo hace alguien de finanzas de verdad. Al
// terminar quita lo suyo de la misma manera.

const emails: string[] = [];
let owner: Client;
let suiteStart: string;
const seenRuns: string[] = [];

beforeAll(async () => {
  owner = await connect();
  await assertPlainWindow(owner);
  const pending = await owner.query<{ n: string }>("select count(*) as n from private.rollup_dirty");
  if (pending.rows[0]?.n !== "0") throw new Error("hay marcas en la base local: pnpm db:reset");
  suiteStart = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
});

afterAll(async () => {
  if (seenRuns.length > 0) await owner.query("delete from public.job_runs where id = any($1::uuid[])", [seenRuns.splice(0)]);
  await dropTransitionLeftovers(owner, suiteStart);
  await deleteTestUsersByEmail(emails);
  await owner.end();
});

const now = async () => (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;

type EstimateRun = { id: string; period_id: number; status: string; error: string | null; input_hash: string | null };

async function estimateRunsSince(start: string, period?: number): Promise<EstimateRun[]> {
  return (
    await owner.query<EstimateRun>(
      `select id::text, period_id, status, error, encode(input_hash, 'hex') as input_hash from private.teacher_estimate_runs
       where started_at >= $1::timestamptz and ($2::int is null or period_id = $2) order by period_id, started_at`,
      [start, period ?? null],
    )
  ).rows;
}

async function rollupRunsSince(start: string): Promise<{ id: string; period_id: number; status: string; error: string | null }[]> {
  const rows = (
    await owner.query<{ id: string; period_id: number; status: string; error: string | null }>(
      "select id::text, period_id, status::text, error from public.job_runs where job = 'nightly_rollup' and started_at >= $1::timestamptz order by period_id",
      [start],
    )
  ).rows;
  seenRuns.push(...rows.map((row) => row.id));
  return rows;
}

const currentPeriod = async () => (await owner.query<{ p: number }>("select private.period_of(now()) as p")).rows[0]!.p;

/** Un disparador de prueba sobre la tabla de las corridas del estimado, que lanza; se quita al terminar, pase o falle. */
async function withBrokenRuns(when: string, work: () => Promise<void>): Promise<void> {
  await owner.query(`create function private.zz_prueba_110_romper() returns trigger language plpgsql set search_path = ''
                     as $$ begin raise exception 'roto a propósito' using errcode = 'P0001'; end $$`);
  await owner.query("revoke all on function private.zz_prueba_110_romper() from public");
  await owner.query(
    `create trigger zz_prueba_110_romper before insert on private.teacher_estimate_runs for each row ${when}
     execute function private.zz_prueba_110_romper()`,
  );
  try {
    await work();
  } finally {
    await owner.query("drop trigger if exists zz_prueba_110_romper on private.teacher_estimate_runs");
    await owner.query("drop function if exists private.zz_prueba_110_romper()");
  }
}

describe("la corrida de verdad", { timeout: 180_000 }, () => {
  it("cada periodo que consolidó deja su estimado, en su propia corrida y con la entrada del cierre", async () => {
    const start = await now();
    const path = (await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path;
    await owner.query("call private.nightly_rollup()");
    expect((await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path).toBe(path);
    const runs = await rollupRunsSince(start);
    const estimates = await estimateRunsSince(start);
    expect(runs.length).toBeGreaterThan(0);
    expect(estimates.map((e) => e.period_id)).toEqual(runs.map((r) => r.period_id));
    for (const run of runs) {
      const estimate = estimates.find((e) => e.period_id === run.period_id)!;
      if (run.status === "succeeded") {
        expect(estimate).toMatchObject({ status: "succeeded", error: null });
        const hash = (
          await owner.query<{ h: string }>("select encode(i.input_hash, 'hex') as h from private.close_input($1) i", [run.period_id])
        ).rows[0]!.h;
        expect(estimate.input_hash).toBe(hash);
      } else {
        expect(estimate).toMatchObject({ status: "failed", error: "rollup failed", input_hash: null });
      }
    }
  });

  it("una consolidación fallida deja su estimado fallido, sin calcular, para que el panel lo diga", async () => {
    // Un periodo anterior a la ventana con una marca: sin umbrales (la semilla los pone desde 202610), su consolidación falla (como en la 43).
    const window = (await owner.query<{ p: number }>("select private.rollup_window() as p order by 1")).rows.map((row) => row.p);
    const older = window[0]! % 100 === 1 ? window[0]! - 89 : window[0]! - 1;
    const mark = [older, randomUUID(), randomUUID()];
    await owner.query("insert into private.rollup_dirty (period_id, profile_id, lesson_id) values ($1, $2, $3)", mark);
    try {
      const start = await now();
      await owner.query("call private.nightly_rollup()");
      const run = (await rollupRunsSince(start)).find((r) => r.period_id === older)!;
      const estimates = await estimateRunsSince(start, older);
      if (run.status === "failed") {
        expect(estimates).toEqual([expect.objectContaining({ status: "failed", error: "rollup failed", input_hash: null })]);
      } else {
        expect(estimates).toEqual([expect.objectContaining({ status: "succeeded" })]);
      }
      expect(run.status).toBe("failed");
    } finally {
      await owner.query("delete from private.rollup_dirty where period_id = $1 and profile_id = $2 and lesson_id = $3", mark);
    }
  });

  it("un paso que falla por dentro deja su corrida fallida; la consolidación termina bien", async () => {
    const period = await currentPeriod();
    const start = await now();
    await withBrokenRuns("when (new.status = 'succeeded')", async () => {
      await owner.query("call private.nightly_rollup(true, $1)", [period]);
    });
    const runs = await rollupRunsSince(start);
    expect(runs).toEqual([expect.objectContaining({ period_id: period, status: "succeeded", error: null })]);
    expect(await estimateRunsSince(start, period)).toEqual([
      expect.objectContaining({ status: "failed", error: "P0001: roto a propósito", input_hash: null }),
    ]);
  });

  it("un paso que lanza no detiene la corrida ni la deja fallida, y la sesión recupera su search_path", async () => {
    const period = await currentPeriod();
    const start = await now();
    const path = (await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path;
    await withBrokenRuns("", async () => {
      await owner.query("call private.nightly_rollup(true, $1)", [period]);
    });
    expect((await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path).toBe(path);
    const runs = await rollupRunsSince(start);
    expect(runs).toEqual([expect.objectContaining({ period_id: period, status: "succeeded", error: null })]);
    expect(await estimateRunsSince(start, period)).toEqual([]);
    // Con la consolidación buena, el cierre no la ve fallida (lo que `close_period` mira es esta corrida).
    const last = await owner.query<{ status: string }>(
      "select status::text from public.job_runs where job = 'nightly_rollup' and period_id = $1 order by started_at desc limit 1",
      [period],
    );
    expect(last.rows[0]!.status).toBe("succeeded");
  });

  it("un recálculo pedido también estima", async (ctx) => {
    const paused = (
      await owner.query<{ p: boolean }>("select private.rollup_requests_paused(now()) or private.rollup_requests_paused(now() + interval '3 minutes') as p")
    ).rows[0]!.p;
    if (paused) ctx.skip();
    const period = await currentPeriod();
    const who = await createTestUser();
    try {
      await owner.query("begin");
      await owner.query("set local session_replication_role = replica");
      const id = (
        await owner.query<{ id: string }>(
          "insert into private.rollup_requests (period_id, requested_by, status) values ($1, $2, 'pending') returning id::text",
          [period, who.id],
        )
      ).rows[0]!.id;
      await owner.query("commit");
      try {
        // El `pg_cron` local también corre el corredor cada minuto: lo corra quien lo corra, se espera a que el pedido termine.
        const runner = await connect();
        try {
          await runner.query("call private.run_rollup_requests()");
        } finally {
          await runner.end();
        }
        const deadline = Date.now() + 120_000;
        let row: { status: string; started_at: string; run_status: string | null };
        for (;;) {
          row = (
            await owner.query<{ status: string; started_at: string; run_status: string | null }>(
              `select q.status, q.started_at::text, j.status::text as run_status
               from private.rollup_requests q left join public.job_runs j on j.id = q.job_run_id where q.id = $1`,
              [id],
            )
          ).rows[0]!;
          if (row.status === "succeeded" || row.status === "failed") break;
          if (Date.now() > deadline) throw new Error(`el pedido no terminó: ${JSON.stringify(row)}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await rollupRunsSince(row.started_at);
        const estimates = await estimateRunsSince(row.started_at, period);
        expect(estimates).toHaveLength(1);
        expect(estimates[0]!.status).toBe(row.run_status === "succeeded" ? "succeeded" : "failed");
      } finally {
        await owner.query("delete from private.rollup_requests where id = $1", [id]);
      }
    } finally {
      await deleteTestUsers([who]);
    }
  });
});

describe("el congelado con dos conexiones", { timeout: 120_000 }, () => {
  const OURS = [204601, 204602];
  let finance: Finance;
  let teacherId = "";
  let students: TestUser[] = [];

  /** Un ensayo confirmado de finanzas. */
  async function rehearse(period: number): Promise<void> {
    const client = await connect();
    try {
      await client.query("begin");
      await actAs(client, finance);
      expect((await outcomeOf(client, "rehearse_close", period)).outcome).toBe("rehearsed");
      await retire(client, finance);
      await client.query("commit");
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  }

  const step = async (client: Client, period: number) =>
    (await client.query<{ r: Record<string, unknown> }>("select private.teacher_estimates_step($1) as r", [period])).rows[0]!.r;

  beforeAll(async () => {
    const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
    if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2046 en la base local: pnpm db:reset");
    await clearPeriodsBefore(owner, OURS[0]!);
    finance = await financePerson(emails);
    students = [await createTestUser(), await createTestUser()];
    const teacher = await createTestUser();
    students.push(teacher);
    await owner.query("begin");
    await asSystem(owner);
    teacherId = (
      await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id::text", [teacher.id])
    ).rows[0]!.id;
    for (const period of OURS) await owner.query("select private.open_period($1)", [period]);
    await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
    await owner.query(
      `update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 2, pool_bps = 6000
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
    await asOwner(owner);
    // Los cobros y el consumo, sin sus cobros ni sus lecciones de verdad: el reparto lee la base de cada alumno y sus medios puntos con el maestro.
    await owner.query("set local session_replication_role = replica");
    for (const period of OURS) {
      for (const [i, s] of students.slice(0, 2).entries()) {
        await owner.query(
          `insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
           values ($1, $2, $3, 'charge', 1, 1, $4, 500, 'charge_date_v1')`,
          [randomUUID(), s.id, period, 28581 + i],
        );
        await owner.query(
          `insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds,
                                            covered_seconds, half_points)
           values ($1, $2, $3, $4, $5, $6, 100, 100, 2)`,
          [period, s.id, randomUUID(), randomUUID(), teacherId, randomUUID()],
        );
      }
    }
    await owner.query("set local session_replication_role = origin");
    await owner.query("commit");
  });

  afterAll(async () => {
    await owner.query("rollback").catch(() => undefined);
    await owner.query("begin");
    try {
      await owner.query("set local session_replication_role = replica");
      await owner.query("delete from private.teacher_period_course_figures where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from private.teacher_period_estimates where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from private.teacher_estimate_runs where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from public.payout_status_events where payout_id in (select id from public.payouts where period_id = any($1::int[]))", [OURS]);
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
      await owner.query("delete from private.close_exports where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from public.close_runs where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from public.job_runs where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from public.watch_rollup where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from public.revenue_allocations where period_id = any($1::int[])", [OURS]);
      await owner.query("delete from public.payout_periods where period_id = any($1::int[])", [OURS]);
      if (teacherId !== "") await owner.query("delete from public.teachers where id = $1", [teacherId]);
      await owner.query("set local session_replication_role = origin");
      await owner.query("commit");
    } catch (error) {
      await owner.query("rollback");
      throw error;
    }
    await deleteTestUsers(students);
  });

  it("el estimado que llega detrás de un cierre en vuelo espera, ve el periodo cerrado y no escribe", async () => {
    await rehearse(OURS[0]!);
    const closer = await connect();
    const estimator = await connect();
    try {
      await closer.query("begin");
      await actAs(closer, finance);
      expect((await outcomeOf(closer, "close_period", OURS[0]!)).outcome).toBe("closed");
      await estimator.query("begin");
      const pending = step(estimator, OURS[0]!);
      await waitBehind(owner, closer, 1);
      await retire(closer, finance);
      await closer.query("commit");
      expect(await pending).toEqual({ outcome: "closed" });
      await estimator.query("commit");
    } finally {
      await closer.query("rollback").catch(() => undefined);
      await estimator.query("rollback").catch(() => undefined);
      await closer.end();
      await estimator.end();
    }
    expect(await estimateRunsSince("-infinity", OURS[0]!)).toEqual([]);
  });

  it("el cierre que llega detrás de un estimado en vuelo espera, y congela lo que el estimado ya escribió", async () => {
    await rehearse(OURS[1]!);
    const closer = await connect();
    const estimator = await connect();
    let estimateRun = "";
    try {
      await estimator.query("begin");
      const estimated = await step(estimator, OURS[1]!);
      expect(estimated.outcome).toBe("estimated");
      estimateRun = String(estimated.run_id);
      await closer.query("begin");
      await actAs(closer, finance);
      const pending = outcomeOf(closer, "close_period", OURS[1]!);
      await waitBehind(owner, estimator, 1);
      await estimator.query("commit");
      expect((await pending).outcome).toBe("closed");
      await retire(closer, finance);
      await closer.query("commit");
    } finally {
      await closer.query("rollback").catch(() => undefined);
      await estimator.query("rollback").catch(() => undefined);
      await closer.end();
      await estimator.end();
    }
    // Lo que estimó es lo que se cerró: la misma entrada y lo asignado de su maestro.
    const same = await owner.query<{ same_input: boolean; same_assigned: boolean }>(
      `select r.input_hash = c.input_hash as same_input, e.assigned_cents = t.assigned_cents as same_assigned
       from private.teacher_estimate_runs r
       join private.teacher_period_estimates e on e.run_id = r.id
       join public.payout_periods p on p.period_id = r.period_id
       join public.close_runs c on c.id = p.close_run_id
       join public.payout_teacher_totals t on t.period_id = r.period_id and t.teacher_id = e.teacher_id
       where r.id = $1`,
      [estimateRun],
    );
    expect(same.rows).toEqual([{ same_input: true, same_assigned: true }]);
    await expect(step(owner, OURS[1]!)).resolves.toEqual({ outcome: "closed" });
    await expect(
      owner.query(
        `insert into private.teacher_estimate_runs (period_id, input_hash, status, started_at, finished_at)
         values ($1, '\\x00', 'succeeded', now(), now())`,
        [OURS[1]],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
