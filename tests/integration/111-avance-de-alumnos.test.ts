import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { askCourseStudents } from "@/services/teachers/course-students-records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { connect, waitBehind } from "./helpers/finance";
import { assertPlainWindow, dropTransitionLeftovers } from "./helpers/periods";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, createTestUser, deleteTestUsers, deleteTestUsersByEmail, type TestUser } from "./helpers/users";

// El avance de los alumnos (T-408, segunda solicitud; PA-51) contra la base local, en lo que una transacción revertida no puede mostrar.
//
// La corrida de verdad: `nightly_rollup` es un procedimiento con `commit`, y aquí corre como lo corre pg_cron, una llamada suelta del dueño. Al
// final de la noche guarda el resumen del avance; un recálculo pedido no lo guarda; un paso que falla por dentro lo anota en su estado, y uno que
// lanza fuera de su bloque o se cancela no detiene la noche. Corre sobre la base local, sin marcas, y al terminar quita lo que dejó.
//
// Los candados de los alias, con dos conexiones: dos lecturas de PA-51 del mismo maestro van una tras otra y no chocan en el único; una de PA-47 no
// espera a una de PA-51.
//
// Y la forma estricta del servidor (`askCourseStudents`) contra lo que la base contesta de verdad, como una maestra con su sesión, en una transacción que
// se revierte.

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

/** La falla del avance que la noche dejó en los detalles de su corrida del paso a cierre, o nulo. */
async function progressFailedSince(start: string): Promise<string | null> {
  const rows = (
    await owner.query<{ failed: string | null }>(
      "select details ->> 'course_progress_failed' as failed from public.job_runs where job = 'period_transition' and started_at >= $1::timestamptz",
      [start],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0]!.failed;
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
    expect(await progressFailedSince(start)).toBeNull();
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
    // Y quien opera la ve donde ve las corridas: en los detalles del paso a cierre de esa noche, sin cambiar su estado.
    const transition = await owner.query<{ failed: string | null }>(
      "select details ->> 'course_progress_failed' as failed from public.job_runs where job = 'period_transition' and started_at >= $1::timestamptz",
      [start],
    );
    expect(transition.rows).toEqual([{ failed: "P0001: roto a propósito" }]);
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
    expect(await progressFailedSince(start)).toBe("P0001: roto a propósito");
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
    expect(await progressFailedSince(start)).toMatch(/^57014: /);
  });
});

describe("una cancelación fuera del bloque del paso", { timeout: 180_000 }, () => {
  it("tampoco corta la noche: la atrapa el bloque de la corrida", async () => {
    const start = await now();
    const runner = await connect();
    try {
      const pid = (await runner.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      // Lo que salió bien lanza, y al anotar la falla (ya fuera del bloque del paso) se queda dormido: ahí lo cancelan.
      await withBrokenState(
        "",
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
        "if new.failed_at is not distinct from old.failed_at then raise exception 'roto a propósito' using errcode = 'P0001'; end if; perform pg_catalog.pg_sleep(30);",
      );
    } finally {
      await runner.end();
    }
    expect((await stateSince(start)).built_since).toBe(false);
    expect((await runsSince(start)).filter((run) => run.job === "period_transition")).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
    expect(await progressFailedSince(start)).toMatch(/^57014: /);
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

  it("una lectura que no tiene alias que crear no espera el candado", async () => {
    const holder = await connect();
    const reader = await connect();
    try {
      await holder.query("begin");
      expect(await insert(holder, "progress", [people[3]!.id])).toBe(1);
      await reader.query("set lock_timeout = '2s'");
      expect(await insert(reader, "progress", [people[0]!.id, people[1]!.id, people[2]!.id])).toBe(0);
      await holder.query("rollback");
    } finally {
      for (const client of [holder, reader]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
  });
});

describe("la forma estricta del servidor, contra la base", () => {
  /** Una persona de verdad, con su sesión del Auth local, como en la 110. */
  async function person(): Promise<{ id: string; claims: VerifiedClaims }> {
    const who = await claimedUser();
    emails.push(who.email);
    await completeAccountAsOwner(who.id);
    const jar = memoryJar();
    const entered = await testServices().signIn(jar, who, freshOrigin());
    if (entered.kind !== "entered") throw new Error(`La persona de prueba no entró: ${entered.kind}`);
    const check = await testServices().checkSession(jar);
    if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
    return { id: who.id, claims: check.claims };
  }

  const txOn = (client: Client): Tx => ({
    query: async (query, row) => (await client.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await client.query(query.text, [...query.values])).rowCount ?? 0,
  });

  it("lo que contesta `teacher_course_students` pasa la forma de `askCourseStudents`: con resumen, y otro curso como uno que no existe", async () => {
    const maestra = await person();
    const students = [await createTestUser(), await createTestUser()];
    try {
      await reverted(async (tx) => {
        await asSystem(tx);
        await tx.query("select set_config('app.local_courses', 'on', true)");
        await tx.query("select private.system_catalog_add('practices', 'Práctica de avance'), private.system_catalog_add('levels', 'Nivel de avance')");
        const teacher = (await tx.query<{ id: string }>("select private.system_add_teacher('Maestra de avance', 'maestra-avance-111', null) as id")).rows[0]!.id;
        const course = {
          slug: "curso-avance-111",
          title: "Curso de avance",
          practice: "practica-de-avance",
          level: "nivel-de-avance",
          modules: [
            {
              title: "Uno",
              lessons: ["Uno", "Dos", "Tres"].map((title) => ({
                title,
                video: { provider: "mux", asset_id: `AssetAvance${title}`, playback_id: `PlaybackAvance${title}`, duration_seconds: 100 },
              })),
            },
          ],
        };
        const loaded = (await tx.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)]))
          .rows[0];
        if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
        await asOwner(tx);
        await tx.query("set local session_replication_role = replica");
        await tx.query("update public.teachers set profile_id = $1, status = 'active' where id = $2", [maestra.id, teacher]);
        const courseId = (
          await tx.query<{ id: string }>(
            `update public.course_registry r set state = 'published', first_published_at = now() - interval '1 year'
             from public.published_courses c where c.course_id = r.course_id and c.slug = 'curso-avance-111' returning r.course_id::text as id`,
          )
        ).rows[0]!.id;
        await tx.query("set local session_replication_role = origin");
        // La primera alumna terminó todo hace dos semanas; la segunda empezó la primera lección.
        await tx.query(
          `insert into public.lesson_progress (profile_id, lesson_id, course_id, video_asset_id, last_position_seconds, first_watched_at, last_watched_at,
                                               completed_at, last_playback_session_id, last_seq)
           select p.id, l.id, l.course_id, l.video_asset_id, 50, now() - interval '15 days', now() - interval '14 days',
                  case when p.n = 1 then now() - interval '14 days' end, gen_random_uuid(), 1
           from public.published_lessons l, (values ($2::uuid, 1), ($3::uuid, 2)) p (id, n)
           where l.course_id = $1 and (p.n = 1 or l.position = (select min(x.position) from public.published_lessons x where x.course_id = $1))`,
          [courseId, students[0]!.id, students[1]!.id],
        );
        // La lista es de cada lunes y no se rehace en la semana: la de esta semana pudo armarla ya otra noche. Se olvida, para que este paso la arme.
        await tx.query("update private.course_progress_state set weekly_cut_at = null, weekly_built_at = null");
        expect((await tx.query<{ r: { outcome: string } }>("select private.course_progress_step() as r")).rows[0]!.r.outcome).toBe("built");

        const { claims } = readVerifiedClaims(maestra.claims);
        await asServer(tx, claims.userId, claims.sessionId ?? "");
        try {
          const read = await askCourseStudents(txOn(tx), { course: courseId, order: "progress", page: 1 });
          if (read.outcome !== "ok") throw new Error(`la maestra no lee su curso: ${read.outcome}`);
          expect(read.value).toMatchObject({
            title: "Curso de avance",
            figures: { started: 2, inProgress: 1, finished: 1 },
            lessons: [
              { title: "Uno", finished: 1 },
              { title: "Dos", finished: 1 },
              { title: "Tres", finished: 1 },
            ],
            page: 1,
            pages: 1,
            totalStudents: 2,
            stale: false,
          });
          expect(read.value.students.map((s) => `${s.completed}/${s.total}`)).toEqual(["3/3", "0/3"]);
          expect(await askCourseStudents(txOn(tx), { course: "00000000-0000-4000-8000-000000000000", order: "alias", page: 1 })).toEqual({ outcome: "not_found" });
        } finally {
          await asOwner(tx);
        }
      });
    } finally {
      await deleteTestUsers(students);
    }
  });
});
