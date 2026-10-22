import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";

// La detección de anomalías dentro de la corrida de cada noche (T-208; RF-406; 05 §8.2, paso 7),
// contra la base local. La corrida es un procedimiento que hace `commit`: aquí corre como la corre
// pg_cron. Qué detecta lo prueba `supabase/tests/29_anomalias.test.sql`, que se revierte; aquí solo
// se mira que la corrida detecta al final de cada periodo de la ventana y lo anota, sin consumo de
// nadie: una alerta va a la auditoría, que no se borra. Las corridas y las marcas que deja se borran
// al terminar cada caso.

let owner: Client;
const seen: string[] = [];
const marks: { period: number; profile: string; lesson: string }[] = [];

beforeAll(async () => {
  owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  const pending = await owner.query<{ marks: string; alerts: string }>(
    "select (select count(*) from private.rollup_dirty) as marks, (select count(*) from public.anomaly_alerts) as alerts",
  );
  if (pending.rows[0]?.marks !== "0" || pending.rows[0]?.alerts !== "0") {
    throw new Error("hay marcas o alertas en la base local: pnpm db:reset");
  }
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

function before(period: number): number {
  return period % 100 === 1 ? period - 89 : period - 1;
}

async function runsSince(
  start: string,
): Promise<{ id: string; period_id: number; status: string; error: string | null; details: Record<string, unknown> }[]> {
  const result = await owner.query(
    "select id, period_id, status::text, error, details from public.job_runs where job = 'nightly_rollup' and started_at > $1::timestamptz order by period_id",
    [start],
  );
  seen.push(...result.rows.map((row: { id: string }) => row.id));
  return result.rows;
}

/** La hora de la base, como texto: un `Date` la corta al milisegundo. */
async function now(): Promise<string> {
  return (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
}

describe("la detección en la corrida de cada noche", () => {
  it("detecta al final de cada periodo de la ventana y anota cuántas alertas abrió", async () => {
    const start = await now();
    await owner.query("call private.nightly_rollup()");
    const runs = await runsSince(start);
    expect(runs.map((run) => run.period_id)).toEqual(await windowPeriods());
    for (const run of runs) {
      expect(run).toMatchObject({ status: "succeeded", details: { alerts_opened: 0 } });
    }
    const alerts = await owner.query<{ n: string }>("select count(*) as n from public.anomaly_alerts");
    expect(alerts.rows[0]!.n).toBe("0");
  });

  // Un periodo anterior a la ventana con una marca se consolida (o falla, sin umbrales de antes del
  // arranque, como en la 43), pero no se detecta: no recibe latidos, y lo que abriera ahí ya nadie
  // lo revisaría antes de cerrar. Lo cuidan la corrida y la propia detección.
  it("un periodo que ya no recibe latidos no se detecta", async () => {
    const [previous] = await windowPeriods();
    const mark = { period: before(previous!), profile: randomUUID(), lesson: randomUUID() };
    marks.push(mark);
    await owner.query("insert into private.rollup_dirty (period_id, profile_id, lesson_id) values ($1, $2, $3)", [
      mark.period,
      mark.profile,
      mark.lesson,
    ]);
    const start = await now();
    await owner.query("call private.nightly_rollup()");
    const older = (await runsSince(start)).find((run) => run.period_id === mark.period);
    expect(older).toBeDefined();
    expect(older!.details).not.toHaveProperty("alerts_opened");
    expect(older!.details).not.toHaveProperty("anomalies_failed");
  });

  it("si la detección falla, la corrida lo anota y termina fallida, y la consolidación ya quedó", async () => {
    // Se quita la detección un momento: la corrida la llama por su nombre.
    await owner.query("alter function private.detect_anomalies(public.period_id, timestamptz) rename to detect_anomalies_fuera");
    try {
      const start = await now();
      await owner.query("call private.nightly_rollup()");
      const runs = await runsSince(start);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.status).toBe("failed");
        expect(run.error).toMatch(/^anomalies failed: 42883/);
        expect(run.details).toHaveProperty("anomalies_failed");
      }
    } finally {
      await owner.query("alter function private.detect_anomalies_fuera(public.period_id, timestamptz) rename to detect_anomalies");
    }
  });
});
