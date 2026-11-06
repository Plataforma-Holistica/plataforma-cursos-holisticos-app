import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, waitBehind } from "./helpers/finance";
import { assertPlainWindow, dropTransitionLeftovers } from "./helpers/periods";
import { asOwner, asSystem } from "./helpers/team";
import { createTestUser, deleteTestUsers, type TestUser } from "./helpers/users";

// El avance de los alumnos (T-408, segunda solicitud; PA-51) contra la base local, en lo que una transacción revertida no puede mostrar.
//
// La corrida de verdad: `nightly_rollup` es un procedimiento con `commit`, y aquí corre como lo corre pg_cron, una llamada suelta del dueño. Al
// final de la noche guarda el resumen del avance; un recálculo pedido no lo guarda; un paso que falla por dentro lo anota en su estado, y uno que
// lanza fuera de su bloque o se cancela no detiene la noche. Corre sobre la base local, sin marcas, y al terminar quita lo que dejó.
//
// Los candados de los alias, con dos conexiones: dos lecturas de PA-51 del mismo maestro van una tras otra y no chocan en el único; una de PA-47 no
// espera a una de PA-51.

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
  await owner.end();
});

const now = async () => (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;

type State = { daily_cut_at: string | null; daily_built_at: string | null; failed_at: string | null; error: string | null; built_since: boolean };

async function stateSince(start: string): Promise<State> {
  return (
    await owner.query<State>(
      `select daily_cut_at::text, daily_built_at::text, failed_at::text, error, coalesce(daily_built_at >= $1::timestamptz, false) as built_since
       from private.course_progress_state`,
      [start],
    )
  ).rows[0]!;
}

/** Las corridas de la consolidación y del paso a cierre desde `start`; se anotan para quitarlas al terminar. */
async function runsSince(start: string): Promise<{ job: string; status: string; error: string | null }[]> {
  const rows = (
    await owner.query<{ id: string; job: string; status: string; error: string | null }>(
      "select id::text, job, status::text, error from public.job_runs where started_at >= $1::timestamptz order by job, period_id",
      [start],
    )
  ).rows;
  seenRuns.push(...rows.filter((row) => row.job === "nightly_rollup").map((row) => row.id));
  return rows.map(({ job, status, error }) => ({ job, status, error }));
}

/**
 * Un disparador de prueba sobre el estado del avance, que lanza (o, con `body`, que hace otra cosa) antes de cambiarlo; se quita al terminar, pase
 * o falle. Se confirma: la corrida de cada noche corre en otras transacciones.
 */
async function withBrokenState(when: string, work: () => Promise<void>, body = "raise exception 'roto a propósito' using errcode = 'P0001';"): Promise<void> {
  await owner.query(`create function private.zz_prueba_111_romper() returns trigger language plpgsql set search_path = ''
                     as $$ begin ${body} return new; end $$`);
  await owner.query("revoke all on function private.zz_prueba_111_romper() from public");
  await owner.query(
    `create trigger zz_prueba_111_romper before update on private.course_progress_state for each row ${when} execute function private.zz_prueba_111_romper()`,
  );
  try {
    await work();
  } finally {
    await owner.query("drop trigger if exists zz_prueba_111_romper on private.course_progress_state");
    await owner.query("drop function if exists private.zz_prueba_111_romper()");
  }
}
// Solo la escritura de lo que salió bien: la que anota una falla cambia `failed_at`.
const ON_SUCCESS = "when (new.failed_at is not distinct from old.failed_at)";

describe("la corrida de verdad", { timeout: 180_000 }, () => {
  it("la noche guarda el avance al final, con el corte en la medianoche de hoy", async () => {
    const start = await now();
    const path = (await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path;
    await owner.query("call private.nightly_rollup()");
    expect((await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path).toBe(path);
    const state = await stateSince(start);
    expect(state.built_since).toBe(true);
    const midnight = (
      await owner.query<{ m: string }>(
        "select (date_trunc('day', now() at time zone private.period_zone()) at time zone private.period_zone())::text as m",
      )
    ).rows[0]!.m;
    expect(state.daily_cut_at).toBe(midnight);
    expect((await runsSince(start)).filter((run) => run.job === "period_transition")).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
  });

  it("un recálculo pedido no lo guarda", async () => {
    const period = (await owner.query<{ p: number }>("select private.period_of(now()) as p")).rows[0]!.p;
    const start = await now();
    await owner.query("call private.nightly_rollup(true, $1)", [period]);
    await runsSince(start);
    expect((await stateSince(start)).built_since).toBe(false);
  });

  it("un paso que falla por dentro anota la falla y deja el resumen anterior; la noche termina bien", async () => {
    const before = await stateSince("-infinity");
    const start = await now();
    await withBrokenState(ON_SUCCESS, async () => {
      await owner.query("call private.nightly_rollup()");
    });
    const state = await stateSince(start);
    expect(state).toMatchObject({ daily_cut_at: before.daily_cut_at, daily_built_at: before.daily_built_at, error: "P0001: roto a propósito" });
    const runs = await runsSince(start);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.every((run) => run.status === "succeeded" && run.error === null)).toBe(true);
  });

  it("un paso que lanza fuera de su bloque no detiene la noche", async () => {
    const start = await now();
    const path = (await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path;
    // Ni la escritura de la falla pasa: el paso lanza, y lo atrapa el bloque de la noche.
    await withBrokenState("", async () => {
      await owner.query("call private.nightly_rollup()");
    });
    expect((await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path).toBe(path);
    expect((await stateSince(start)).built_since).toBe(false);
    const runs = await runsSince(start);
    expect(runs.filter((run) => run.job === "period_transition")).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
  });

  it("un paso cancelado anota 57014, y la noche termina bien", async () => {
    const start = await now();
    const runner = await connect();
    try {
      const pid = (await runner.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      // El paso se queda dormido al escribir que salió bien; mientras duerme, alguien cancela la consulta. La escritura de la falla no duerme.
      await withBrokenState(
        ON_SUCCESS,
        async () => {
          const call = runner.query("call private.nightly_rollup()");
          const deadline = Date.now() + 60_000;
          for (;;) {
            const sleeping = await owner.query("select 1 from pg_stat_activity where pid = $1 and wait_event = 'PgSleep'", [pid]);
            if ((sleeping.rowCount ?? 0) > 0) break;
            if (Date.now() > deadline) throw new Error("el paso no llegó a dormirse");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await owner.query("select pg_cancel_backend($1)", [pid]);
          await call;
        },
        "perform pg_catalog.pg_sleep(30);",
      );
    } finally {
      await runner.end();
    }
    const state = await stateSince(start);
    expect(state.built_since).toBe(false);
    expect(state.error).toMatch(/^57014: /);
    expect((await runsSince(start)).filter((run) => run.job === "period_transition")).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
  });
});

describe("los candados de los alias, con dos conexiones", { timeout: 60_000 }, () => {
  let teacherId = "";
  let people: TestUser[] = [];

  beforeAll(async () => {
    people = [await createTestUser(), await createTestUser(), await createTestUser(), await createTestUser()];
    await owner.query("begin");
    await asSystem(owner);
    teacherId = (
      await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id::text", [people[3]!.id])
    ).rows[0]!.id;
    await asOwner(owner);
    await owner.query("commit");
  });

  afterAll(async () => {
    await owner.query("rollback").catch(() => undefined);
    await owner.query("begin");
    try {
      await owner.query("set local session_replication_role = replica");
      await owner.query("delete from private.progress_aliases where teacher_id = $1", [teacherId]);
      await owner.query("delete from private.student_aliases where teacher_id = $1", [teacherId]);
      if (teacherId !== "") await owner.query("delete from public.teachers where id = $1", [teacherId]);
      await owner.query("set local session_replication_role = origin");
      await owner.query("commit");
    } catch (error) {
      await owner.query("rollback");
      throw error;
    }
    await deleteTestUsers(people);
  });

  const insert = async (client: Client, kind: string, ids: string[]) =>
    (await client.query<{ n: number }>("select private.alias_insert($1, $2, $3::uuid[]) as n", [kind, teacherId, ids])).rows[0]!.n;

  it("dos lecturas de PA-51 van una tras otra, sin chocar; una de PA-47 no espera", async () => {
    const first = await connect();
    const second = await connect();
    const report = await connect();
    try {
      await first.query("begin");
      expect(await insert(first, "progress", [people[0]!.id, people[1]!.id])).toBe(2);
      await second.query("begin");
      const pending = insert(second, "progress", [people[0]!.id, people[1]!.id, people[2]!.id]);
      await waitBehind(owner, first, 1);
      // PA-47 tiene su propio candado: no espera a la lectura de PA-51 en vuelo.
      await report.query("set lock_timeout = '2s'");
      await report.query("begin");
      expect(await insert(report, "student", [people[0]!.id])).toBe(1);
      await report.query("commit");
      await first.query("commit");
      // La segunda ve los dos que la primera confirmó y solo crea el tercero.
      expect(await pending).toBe(1);
      await second.query("commit");
    } finally {
      for (const client of [first, second, report]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    const aliases = await owner.query<{ n: number; distinct_aliases: number }>(
      "select count(*)::int as n, count(distinct alias)::int as distinct_aliases from private.progress_aliases where teacher_id = $1",
      [teacherId],
    );
    expect(aliases.rows[0]).toEqual({ n: 3, distinct_aliases: 3 });
  });
});
