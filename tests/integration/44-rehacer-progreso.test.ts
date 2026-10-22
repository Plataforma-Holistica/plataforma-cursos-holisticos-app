import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { knownUser } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";

// La corrida que rehace el progreso que falló (T-207; RF-307; 05 §5.7 y §13), contra la base local.
// Es un procedimiento que hace `commit` entre pares: aquí corre como lo corre pg_cron, una llamada
// suelta del dueño de la base. Cómo se rehace un par lo prueba `supabase/tests/26_rehacer_progreso.test.sql`,
// que se revierte; aquí solo se anotan pares de cuentas que no existen o sin reproducciones, que no
// dejan progreso ni latidos: el libro no admite borrado. Por eso el camino de un par que vuelve a
// fallar solo se prueba ahí, y el de la corrida que lo cuenta, con `close_job_run`. Las corridas y
// las anotaciones se borran al terminar cada caso.

let owner: Client;
let other: Client;
const seen: string[] = [];
const notes: { profile: string; lesson: string }[] = [];

beforeAll(async () => {
  owner = new Client({ connectionString: localOwnerUrl() });
  other = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  await other.connect();
  // Con anotaciones de otra cosa, la corrida rehará progreso de verdad y confirmará.
  const pending = await owner.query<{ n: string }>("select count(*) as n from private.progress_rebuilds");
  if (pending.rows[0]?.n !== "0") throw new Error("hay progreso por rehacer en la base local: pnpm db:reset");
});
afterEach(async () => {
  for (const note of notes.splice(0)) {
    await owner.query("delete from private.progress_rebuilds where profile_id = $1 and lesson_id = $2", [note.profile, note.lesson]);
  }
  if (seen.length > 0) await owner.query("delete from public.job_runs where id = any($1::uuid[])", [seen.splice(0)]);
});
afterAll(async () => {
  await other.end();
  await owner.end();
});

/** Anota un par: por omisión, de una cuenta que no existe y con la hora de ahora. */
async function note(profile: string = randomUUID(), failedAt: string | null = null): Promise<{ profile: string; lesson: string }> {
  const pair = { profile, lesson: randomUUID() };
  notes.push(pair);
  await owner.query(
    "insert into private.progress_rebuilds (profile_id, lesson_id, code, failed_at) values ($1, $2, 'P0001', coalesce($3::timestamptz, now()))",
    [pair.profile, pair.lesson, failedAt],
  );
  return pair;
}

async function noted(pair: { profile: string; lesson: string }): Promise<boolean> {
  const result = await owner.query("select 1 from private.progress_rebuilds where profile_id = $1 and lesson_id = $2", [
    pair.profile,
    pair.lesson,
  ]);
  return result.rowCount === 1;
}

async function runsSince(
  start: string,
): Promise<{ id: string; status: string; rows_read: string; rows_written: string; period_id: number | null; details: Record<string, unknown> }[]> {
  const result = await owner.query(
    "select id, status::text, rows_read, rows_written, period_id, details from public.job_runs where job = 'progress_rebuild' and started_at > $1::timestamptz order by started_at",
    [start],
  );
  seen.push(...result.rows.map((row: { id: string }) => row.id));
  return result.rows;
}

/** La hora de la base, como texto: un `Date` la corta al milisegundo. */
async function now(): Promise<string> {
  return (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
}

describe("la corrida de cada hora", () => {
  it("sin nada que rehacer, abre y cierra su corrida, y le devuelve a la sesión su search_path", async () => {
    const start = await now();
    const path = (await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path;
    await owner.query("call private.rebuild_progress()");
    expect((await owner.query<{ search_path: string }>("show search_path")).rows[0]!.search_path).toBe(path);
    const runs = await runsSince(start);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", rows_read: "0", rows_written: "0", period_id: null, details: { mode: "rebuild" } });
  });

  it("el par de una cuenta que ya no existe sale de la tabla", async () => {
    const pair = await note();
    const start = await now();
    await owner.query("call private.rebuild_progress()");
    expect(await noted(pair)).toBe(false);
    const runs = await runsSince(start);
    expect(runs[0]).toMatchObject({ status: "succeeded", rows_read: "1", rows_written: "0", details: { pairs_gone: 1 } });
  });

  it("recorre varios pares con commit entre uno y otro, y lo anotado después de arrancar espera a la siguiente", async () => {
    // Una cuenta que existe y no tiene reproducciones: sus pares se rehacen sin escribir progreso
    // ni tocar el libro, así que no dejan nada.
    const user = await knownUser();
    const first = await note(user.id);
    const second = await note(user.id);
    const gone = await note();
    const later = await note(user.id, "2999-01-01T00:00:00Z");
    const start = await now();
    await owner.query("call private.rebuild_progress()");
    expect(await noted(first)).toBe(false);
    expect(await noted(second)).toBe(false);
    expect(await noted(gone)).toBe(false);
    expect(await noted(later)).toBe(true);
    const runs = await runsSince(start);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", rows_read: "3", rows_written: "2", details: { mode: "rebuild", pairs_gone: 1 } });
    const progress = await owner.query("select 1 from public.lesson_progress where profile_id = $1", [user.id]);
    expect(progress.rowCount).toBe(0);
  });

  it("con un lote de la cuenta en curso no espera: el par se queda para la hora siguiente", async () => {
    const pair = await note();
    await other.query("select pg_advisory_lock(hashtextextended('playback:' || $1, 0))", [pair.profile]);
    try {
      const start = await now();
      await owner.query("call private.rebuild_progress()");
      expect(await noted(pair)).toBe(true);
      const runs = await runsSince(start);
      expect(runs[0]).toMatchObject({ status: "succeeded", rows_read: "1", details: { pairs_busy: 1 } });
    } finally {
      await other.query("select pg_advisory_unlock(hashtextextended('playback:' || $1, 0))", [pair.profile]);
    }
  });

  it("si otra corrida sigue viva, esta no arranca", async () => {
    const pair = await note();
    const held = await owner.query<{ id: string }>("select private.open_job_run('progress_rebuild', null, 'rebuild') as id");
    seen.push(held.rows[0]!.id);
    const start = await now();
    await owner.query("call private.rebuild_progress()");
    expect(await runsSince(start)).toHaveLength(0);
    expect(await noted(pair)).toBe(true);
  });

  it("rehacer un par se niega fuera de read committed: tiene que ver lo confirmado después del candado", async () => {
    await owner.query("begin isolation level repeatable read");
    try {
      await expect(owner.query("select private.rebuild_pair($1, $2, now())", [randomUUID(), randomUUID()])).rejects.toMatchObject({
        code: "25000",
      });
    } finally {
      await owner.query("rollback");
    }
  });

  it("dentro de una transacción no corre: pg_cron la llama suelta", async () => {
    await owner.query("begin");
    try {
      await expect(owner.query("call private.rebuild_progress()")).rejects.toMatchObject({ code: "2D000" });
    } finally {
      await owner.query("rollback");
    }
  });
});
