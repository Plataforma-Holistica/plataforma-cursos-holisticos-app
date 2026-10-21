import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";

// La corrida de la consolidación (T-207; RF-405, RF-408; 05 §8.2), contra la base local. Es un
// procedimiento que hace `commit` entre pasos, y eso no se puede probar dentro de una
// transacción: aquí corre como lo corre pg_cron, una llamada suelta del dueño de la base. Lo que
// consolida cada paso lo prueba `supabase/tests/25_consolidacion.test.sql`, que se revierte; aquí
// solo se mira la corrida sin latidos de nadie, para no dejar consolidado ni latidos (el libro no
// se borra). Las corridas y las marcas que deja se borran al terminar cada caso.

let owner: Client;
const seen: string[] = [];
const marks: { period: number; profile: string; lesson: string }[] = [];

beforeAll(async () => {
  owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  // Con marcas de otra cosa, la corrida consolidaría y confirmaría: no se puede deshacer.
  const pending = await owner.query<{ n: string }>("select count(*) as n from private.rollup_dirty");
  if (pending.rows[0]?.n !== "0") throw new Error("hay marcas en la base local: pnpm db:reset");
});
afterEach(async () => {
  for (const mark of marks.splice(0)) {
    await owner.query("delete from private.rollup_dirty where period_id = $1 and profile_id = $2 and lesson_id = $3", [
      mark.period,
      mark.profile,
      mark.lesson,
    ]);
  }
  if (seen.length > 0) await owner.query("delete from public.job_runs where id = any($1::uuid[])", [seen.splice(0)]);
});
afterAll(async () => {
  await owner.end();
});

async function windowPeriods(): Promise<number[]> {
  const result = await owner.query<{ period: number }>("select private.rollup_window() as period order by 1");
  return result.rows.map((row) => row.period);
}

/** El periodo anterior a `period` (aaaamm). */
function before(period: number): number {
  return period % 100 === 1 ? period - 89 : period - 1;
}

async function runsSince(
  start: Date,
): Promise<{ id: string; period_id: number; status: string; rows_read: string; error: string | null; details: { mode: string } }[]> {
  const result = await owner.query(
    "select id, period_id, status::text, rows_read, error, details from public.job_runs where job = 'nightly_rollup' and started_at >= $1 order by period_id",
    [start],
  );
  seen.push(...result.rows.map((row: { id: string }) => row.id));
  return result.rows;
}

async function now(): Promise<Date> {
  return (await owner.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
}

describe("la corrida de cada noche", () => {
  it("abre, recorre y cierra una corrida por cada periodo de la ventana, y le devuelve a la sesión su search_path", async () => {
    const start = await now();
    const path = (await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path;
    await owner.query("call private.nightly_rollup()");
    expect((await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path).toBe(path);
    const runs = await runsSince(start);
    expect(runs.map((run) => run.period_id)).toEqual(await windowPeriods());
    for (const run of runs) {
      expect(run.status).toBe("succeeded");
      expect(run.rows_read).toBe("0");
      expect(run.details.mode).toBe("dirty");
    }
  });

  it("recorre también un periodo anterior a la ventana que todavía tiene marcas", async () => {
    const [previous, current] = await windowPeriods();
    const older = before(previous!);
    const mark = { period: older, profile: randomUUID(), lesson: randomUUID() };
    marks.push(mark);
    await owner.query("insert into private.rollup_dirty (period_id, profile_id, lesson_id) values ($1, $2, $3)", [
      mark.period,
      mark.profile,
      mark.lesson,
    ]);
    const start = await now();
    await owner.query("call private.nightly_rollup()");
    const runs = await runsSince(start);
    expect(runs.map((run) => run.period_id)).toEqual([older, previous, current]);
    const left = await owner.query<{ n: string }>("select count(*) as n from private.rollup_dirty where period_id = $1", [older]);
    // Sin umbrales para ese periodo (la semilla los pone desde 202610), falla y la marca se queda;
    // con ellos, el par sin latidos no deja nada y la marca se va.
    if (runs[0]!.status === "succeeded") {
      expect(left.rows[0]?.n).toBe("0");
    } else {
      expect(runs[0]).toMatchObject({ status: "failed" });
      expect(runs[0]!.error).toMatch(/^P0001: /);
      expect(left.rows[0]?.n).toBe("1");
    }
  });

  it("el recálculo completo de un periodo de la ventana corre solo ese periodo", async () => {
    const [, current] = await windowPeriods();
    const start = await now();
    await owner.query(`call private.nightly_rollup(true, ${Number(current)})`);
    const runs = await runsSince(start);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ period_id: current, status: "succeeded" });
    expect(runs[0]?.details.mode).toBe("full");
  });

  it("no recalcula un periodo que ya no recibe latidos", async () => {
    const [previous] = await windowPeriods();
    await expect(owner.query(`call private.nightly_rollup(true, ${Number(before(previous!))})`)).rejects.toMatchObject({ code: "22023" });
  });

  it("si otra corrida del mismo periodo sigue viva, esa no arranca y la otra sí", async () => {
    const [previous, current] = await windowPeriods();
    const held = await owner.query<{ id: string }>("select private.open_job_run('nightly_rollup', $1, 'dirty') as id", [current]);
    seen.push(held.rows[0]!.id);
    const start = await now();
    await owner.query("call private.nightly_rollup()");
    const runs = await runsSince(start);
    expect(runs.map((run) => run.period_id)).toEqual([previous]);
    const still = await owner.query<{ status: string }>("select status::text from public.job_runs where id = $1", [held.rows[0]!.id]);
    expect(still.rows[0]?.status).toBe("running");
  });

  it("un paso se niega fuera de read committed: borrar una marca solo si sigue como se leyó lo necesita", async () => {
    const [, current] = await windowPeriods();
    await owner.query("begin isolation level repeatable read");
    try {
      const run = await owner.query<{ id: string }>("select private.open_job_run('nightly_rollup', $1, 'dirty') as id", [current]);
      await expect(owner.query("select private.rollup_step($1, clock_timestamp())", [run.rows[0]!.id])).rejects.toMatchObject({
        code: "25000",
      });
    } finally {
      await owner.query("rollback");
    }
  });

  it("dentro de una transacción no corre: pg_cron la llama suelta", async () => {
    await owner.query("begin");
    try {
      await expect(owner.query("call private.nightly_rollup()")).rejects.toMatchObject({ code: "2D000" });
    } finally {
      await owner.query("rollback");
    }
  });
});
