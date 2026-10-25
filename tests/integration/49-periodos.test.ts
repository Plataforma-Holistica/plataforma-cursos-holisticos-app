import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";
import { assertPlainWindow, dropTransitionLeftovers } from "./helpers/periods";
import { createTestUser, deleteTestUsers } from "./helpers/users";

// Los periodos (T-601; RF-501) contra la base local, en lo que una transacción revertida no puede
// mostrar: dos que abren el mismo periodo a la vez dejan una sola fila; el paso a cierre espera al
// cobro que leyó el periodo abierto (y al revés); y la corrida de cada noche, que hace `commit`, toma
// la foto de los periodos que terminaron al empezar y pasa a cierre al terminar. Qué hace cada regla
// lo prueban `supabase/tests/40_periodos.test.sql` y `41_tramos.test.sql`.
//
// Usa meses de la segunda mitad de 2020 y del primer trimestre de 2022, que ninguna otra prueba usa.
// Las filas de periodo no se borran: la limpieza las quita con su guardián apagado, solo esas; las
// corridas que deja, también. La auditoría se queda.

const OPEN = 202006;
const LOCKED = 202007;
const NIGHTLY = 202008;
const FIRST = 202009;
const SECOND = 202010;
const CLOSED = 202011;
const FAILING = 202012;
const RETRY_FROM = 202201;
const RETRY_NEXT = 202202;
const NO_PHOTO = 202203;
const MANUAL = 202204;
const OURS = [OPEN, LOCKED, NIGHTLY, FIRST, SECOND, CLOSED, FAILING, RETRY_FROM, RETRY_NEXT, NO_PHOTO, MANUAL];

let owner: Client;
let suiteStart: string;

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  return client;
}

async function status(period: number): Promise<string | null> {
  const result = await owner.query<{ status: string }>("select status::text from public.payout_periods where period_id = $1", [period]);
  return result.rows[0]?.status ?? null;
}

/** Una transacción del dueño declarado sistema (la auditoría pide autor); si falla, se deshace. */
async function asSystem(work: () => Promise<unknown>): Promise<void> {
  await owner.query("begin");
  try {
    await owner.query("select set_config('app.actor_kind', 'system', true)");
    await work();
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
}

/** Una fila abierta. */
function openRow(period: number): Promise<void> {
  return asSystem(() =>
    owner.query(
      `insert into public.payout_periods (period_id, starts_at, ends_at, timezone)
       select $1::int, b.starts_at, b.ends_at, 'America/Mexico_City' from private.month_bounds($1, 'America/Mexico_City') b`,
      [period],
    ),
  );
}

/** La foto de un periodo que terminó (sin ella no pasa a cierre), como la toma la corrida: 0 alumnos. */
function photo(period: number): Promise<void> {
  return asSystem(() => owner.query("update public.payout_periods set active_students = 0 where period_id = $1", [period]));
}

/** Un estado que T-601 todavía no escribe (cerrado), con el guardián apagado. */
function force(period: number, next: string): Promise<void> {
  return asSystem(async () => {
    await owner.query("alter table public.payout_periods disable trigger payout_periods_guard");
    await owner.query(
      `update public.payout_periods set status = $2::public.period_status,
              entered_closing_at = case when $2 = 'open' then null else coalesce(entered_closing_at, now()) end
       where period_id = $1`,
      [period, next],
    );
    await owner.query("alter table public.payout_periods enable trigger payout_periods_guard");
  });
}

/** Espera a que `count` conexiones estén detenidas por la de `first`. */
async function waitBehind(first: Client, count: number): Promise<void> {
  const pid = (await first.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const deadline = Date.now() + 4_000;
  for (;;) {
    const rows = await owner.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where wait_event_type in ('Lock', 'Advisory') and $1::int = any(pg_blocking_pids(pid))`,
      [pid],
    );
    if ((rows.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error("La otra conexión no llegó a esperar.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  owner = await connect();
  // Con marcas de otra cosa, la corrida consolidaría y confirmaría: no se puede deshacer.
  const pending = await owner.query<{ n: string }>("select count(*) as n from private.rollup_dirty");
  if (pending.rows[0]?.n !== "0") throw new Error("hay marcas en la base local: pnpm db:reset");
  await assertPlainWindow(owner);
  suiteStart = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2020 o 2022 en la base local: pnpm db:reset");
});

afterAll(async () => {
  await asSystem(async () => {
    await owner.query("alter table public.payout_periods disable trigger payout_periods_guard");
    await owner.query("delete from public.payout_periods where period_id = any($1::int[])", [OURS]);
    await owner.query("alter table public.payout_periods enable trigger payout_periods_guard");
  });
  const guard = await owner.query<{ off: number }>(
    "select count(*)::int as off from pg_trigger where tgrelid = 'public.payout_periods'::regclass and tgenabled = 'D'",
  );
  expect(guard.rows[0]?.off).toBe(0);
  await dropTransitionLeftovers(owner, suiteStart);
  // La partición que creó la prueba del sellado.
  await owner.query(`drop table if exists public.watch_events_${CLOSED}`);
  await owner.end();
});

describe("los periodos a la vez", () => {
  it("dos que abren el mismo periodo dejan una sola fila, y solo uno dice que la abrió", async () => {
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      expect((await first.query("select private.open_period($1) as created", [OPEN])).rows[0].created).toBe(true);
      const waiting = second.query<{ created: boolean }>("select private.open_period($1) as created", [OPEN]);
      await waitBehind(first, 1);
      await first.query("commit");
      expect((await waiting).rows[0]!.created).toBe(false);
      const rows = await owner.query("select status::text from public.payout_periods where period_id = $1", [OPEN]);
      expect(rows.rows).toEqual([{ status: "closing" }]);
    } finally {
      await first.query("rollback").catch(() => undefined);
      await Promise.all([first, second].map((client) => client.end()));
    }
  });

  it("abrir uno que ya existe no espera a otro que se está abriendo", async () => {
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      expect((await first.query("select private.open_period($1) as created", [FIRST])).rows[0].created).toBe(true);
      const answer = await Promise.race([
        second.query<{ created: boolean }>("select private.open_period($1) as created", [OPEN]).then((result) => result.rows[0]!.created),
        new Promise((resolve) => setTimeout(() => resolve("esperó"), 2_000)),
      ]);
      expect(answer).toBe(false);
      await first.query("rollback");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await Promise.all([first, second].map((client) => client.end()));
    }
  });

  it("dos periodos distintos que se abren a la vez no se esperan", async () => {
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      expect((await first.query("select private.open_period($1) as created", [FIRST])).rows[0].created).toBe(true);
      const answer = await Promise.race([
        second.query<{ created: boolean }>("select private.open_period($1) as created", [SECOND]).then((result) => result.rows[0]!.created),
        new Promise((resolve) => setTimeout(() => resolve("esperó"), 2_000)),
      ]);
      expect(answer).toBe(true);
      await first.query("commit");
      expect([await status(FIRST), await status(SECOND)]).toEqual(["closing", "closing"]);
    } finally {
      await first.query("rollback").catch(() => undefined);
      await Promise.all([first, second].map((client) => client.end()));
    }
  });

  it("un cobro tardío que encuentra el siguiente pasando a cierre busca otro abierto", async () => {
    await openRow(RETRY_FROM);
    await force(RETRY_FROM, "closed");
    await openRow(RETRY_NEXT);
    await photo(RETRY_NEXT);
    const transition = await connect();
    const charge = await connect();
    try {
      await transition.query("begin");
      expect(
        (await transition.query("select private.period_transition(array[$1::int]) -> 'entered_closing' as moved", [RETRY_NEXT])).rows[0].moved,
      ).toEqual([RETRY_NEXT]);
      const waiting = charge.query<{ start: number }>("select private.allocation_start($1) as start", [RETRY_FROM]);
      await waitBehind(transition, 1);
      await transition.query("commit");
      const start = (await waiting).rows[0]!.start;
      expect(start).not.toBe(RETRY_NEXT);
      expect(start).toBeGreaterThan(RETRY_NEXT);
      const open = await owner.query<{ status: string }>("select private.period_status_of($1)::text as status", [start]);
      expect(open.rows[0]!.status).toBe("open");
    } finally {
      await transition.query("rollback").catch(() => undefined);
      await Promise.all([transition, charge].map((client) => client.end()));
    }
  });

  it("el paso a cierre espera al cobro que leyó el periodo abierto", async () => {
    await openRow(LOCKED);
    await photo(LOCKED);
    const charge = await connect();
    const transition = await connect();
    try {
      await charge.query("begin");
      expect((await charge.query("select private.allocation_start($1) as start", [LOCKED])).rows[0].start).toBe(LOCKED);
      const waiting = transition.query<{ moved: number[] }>(
        "select private.period_transition(array[$1::int]) -> 'entered_closing' as moved",
        [LOCKED],
      );
      await waitBehind(charge, 1);
      expect(await status(LOCKED)).toBe("open");
      await charge.query("commit");
      expect((await waiting).rows[0]!.moved).toEqual([LOCKED]);
      expect(await status(LOCKED)).toBe("closing");
    } finally {
      await charge.query("rollback").catch(() => undefined);
      await Promise.all([charge, transition].map((client) => client.end()));
    }
  });

  it("y un cobro que llega mientras pasa a cierre lo espera y ve el estado nuevo", async () => {
    const transition = await connect();
    const charge = await connect();
    try {
      // El periodo de la prueba anterior ya está en cierre: aquí se vuelve a abrir con el guardián
      // apagado, para pasarlo otra vez.
      await force(LOCKED, "open");
      await transition.query("begin");
      expect((await transition.query("select private.period_transition(array[$1::int]) -> 'entered_closing' as moved", [LOCKED])).rows[0].moved).toEqual([
        LOCKED,
      ]);
      const waiting = charge.query<{ start: number }>("select private.allocation_start($1) as start", [LOCKED]);
      await waitBehind(transition, 1);
      await transition.query("commit");
      // En cierre todavía recibe cobros: el suyo empieza ahí.
      expect((await waiting).rows[0]!.start).toBe(LOCKED);
      expect(await status(LOCKED)).toBe("closing");
    } finally {
      await transition.query("rollback").catch(() => undefined);
      await Promise.all([transition, charge].map((client) => client.end()));
    }
  });
});

describe("la corrida de cada noche", () => {
  it("al terminar pasa a cierre lo que llegó a su día y se consolidó, y lo anota en su propia corrida", async () => {
    await openRow(NIGHTLY);
    const start = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
    try {
      await owner.query("call private.nightly_rollup()");
      expect(await status(NIGHTLY)).toBe("closing");
      const runs = await owner.query<{ job: string; period_id: number | null; status: string; details: Record<string, unknown> }>(
        `select job, period_id, status::text, details from public.job_runs
         where started_at > $1::timestamptz and (job = 'period_transition' or period_id = $2) order by job`,
        [start, NIGHTLY],
      );
      expect(runs.rows.map((run) => [run.job, run.period_id, run.status])).toEqual([
        ["nightly_rollup", NIGHTLY, "succeeded"],
        ["period_transition", null, "succeeded"],
      ]);
      expect(runs.rows[1]!.details.entered_closing).toContain(NIGHTLY);
      // Antes de consolidar tomó su foto: sin ella no habría pasado a cierre.
      expect((runs.rows[1]!.details.photos as { taken: number[] }).taken).toContain(NIGHTLY);
      const taken = await owner.query("select active_students from public.payout_periods where period_id = $1", [NIGHTLY]);
      expect(taken.rows).toEqual([{ active_students: 0 }]);
      const ahead = await owner.query<{ n: number }>(
        `select count(*)::int as n from public.payout_periods
         where period_id in (select private.period_plus(private.period_of(now()), k) from generate_series(0, 2) k) and status = 'open'`,
      );
      expect(ahead.rows[0]!.n).toBe(3);
      // Con un solo periodo es un recálculo a mano: no pasa nada a cierre, ni se toma ninguna foto.
      await openRow(MANUAL);
      const manual = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
      await owner.query("call private.nightly_rollup(false, private.period_of(now()))");
      const untaken = await owner.query("select active_students from public.payout_periods where period_id = $1", [MANUAL]);
      expect(untaken.rows).toEqual([{ active_students: null }]);
      const transitions = await owner.query("select 1 from public.job_runs where job = 'period_transition' and started_at > $1::timestamptz", [
        manual,
      ]);
      expect(transitions.rowCount).toBe(0);
    } finally {
      await owner.query("delete from public.job_runs where started_at > $1::timestamptz and job <> 'period_transition'", [start]);
    }
  });

  it("lo que falló al consolidarse se queda abierto, y lo cerrado ni se consolida", async () => {
    await openRow(FAILING);
    await openRow(CLOSED);
    await force(CLOSED, "closed");
    // Una marca en cada uno. En 2020 no hay umbrales: consolidar su marca es un error de paso.
    const mark = "00000000-0000-4000-8000-000000000049";
    await owner.query("insert into private.rollup_dirty (period_id, profile_id, lesson_id) values ($1, $3, $3), ($2, $3, $3)", [
      FAILING,
      CLOSED,
      mark,
    ]);
    const start = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
    // Ayer también se quedó abierto (T-602): la segunda noche seguida, la corrida del paso lo dice y falla.
    const yesterday = (
      await owner.query<{ id: string }>(
        `insert into public.job_runs (job, status, started_at, heartbeat_at, finished_at, details)
         select 'period_transition', 'succeeded', t, t, t, jsonb_build_object('held_open', jsonb_build_array($1::int))
         from (select timezone('America/Mexico_City', date_trunc('day', timezone('America/Mexico_City', now())) - interval '12 hours') as t) x
         returning id`,
        [FAILING],
      )
    ).rows[0]!.id;
    try {
      await owner.query("call private.nightly_rollup()");
      const runs = await owner.query<{ job: string; period_id: number | null; status: string; error: string | null; details: Record<string, unknown> }>(
        `select job, period_id, status::text, error, details from public.job_runs
         where started_at > $1::timestamptz and (job = 'period_transition' or period_id in ($2, $3)) order by job`,
        [start, FAILING, CLOSED],
      );
      expect(runs.rows.map((run) => [run.job, run.period_id, run.status])).toEqual([
        ["nightly_rollup", FAILING, "failed"],
        ["period_transition", null, "failed"],
      ]);
      expect(runs.rows[1]!.details.held_open).toContain(FAILING);
      expect(runs.rows[1]!.details.held_open_again).toEqual([FAILING]);
      expect(runs.rows[1]!.error).toMatch(/held open again/);
      expect(await status(FAILING)).toBe("open");
      const left = await owner.query("select period_id from private.rollup_dirty where profile_id = $1 order by 1", [mark]);
      expect(left.rows.map((row: { period_id: number }) => row.period_id)).toEqual([CLOSED, FAILING]);
    } finally {
      await owner.query("delete from public.job_runs where id = $1", [yesterday]);
      await owner.query("delete from private.rollup_dirty where profile_id = $1", [mark]);
      await owner.query("delete from public.job_runs where started_at > $1::timestamptz and job <> 'period_transition'", [start]);
    }
  });

  it("la primera noche en cierre recalcula completo, y al terminar sella lo cerrado (T-602)", async () => {
    // NIGHTLY pasó a cierre en una prueba anterior; CLOSED está cerrado. La partición de CLOSED, para sellarla.
    expect(await status(NIGHTLY)).toBe("closing");
    await owner.query("select private.create_watch_partition($1)", [CLOSED]);
    const start = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
    // Alguien lee la partición mientras la corrida quiere sellarla: espera 2 s, no la sella y lo dice.
    const reader = await connect();
    try {
      await reader.query("begin");
      await reader.query(`select 1 from public.watch_events_${CLOSED} limit 1`);
      await owner.query("call private.nightly_rollup()");
      await reader.query("rollback");
      const failed = await owner.query<{ status: string; failures: Record<string, string> | null }>(
        "select status::text, details -> 'seal_failed' as failures from public.job_runs where job = 'period_transition' and started_at > $1::timestamptz",
        [start],
      );
      expect(failed.rows[0]!.status).toBe("failed");
      expect(Object.keys(failed.rows[0]!.failures ?? {})).toEqual([String(CLOSED)]);
      const first = await owner.query<{ mode: string }>(
        "select details ->> 'mode' as mode from public.job_runs where job = 'nightly_rollup' and period_id = $1 and started_at > $2::timestamptz",
        [NIGHTLY, start],
      );
      expect(first.rows).toEqual([{ mode: "full" }]);
      // Sin quien la lea, la noche siguiente la sella.
      const again = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
      await owner.query("call private.nightly_rollup()");
      const transition = await owner.query<{ sealed: number[] }>(
        "select details -> 'sealed' as sealed from public.job_runs where job = 'period_transition' and started_at > $1::timestamptz",
        [again],
      );
      expect(transition.rows[0]!.sealed).toContain(CLOSED);
      const sealed = await owner.query("select 1 from pg_constraint where conname = $1", [`watch_events_${CLOSED}_sealed`]);
      expect(sealed.rowCount).toBe(1);
      const second = await owner.query<{ mode: string }>(
        "select details ->> 'mode' as mode from public.job_runs where job = 'nightly_rollup' and period_id = $1 and started_at > $2::timestamptz",
        [NIGHTLY, again],
      );
      expect(second.rows).toEqual([{ mode: "dirty" }]);
    } finally {
      await reader.query("rollback").catch(() => undefined);
      await reader.end();
      await owner.query("delete from public.job_runs where started_at > $1::timestamptz and job <> 'period_transition'", [start]);
    }
  });

  it("una foto que falla deja el periodo abierto, y la corrida del paso a cierre fallida", async () => {
    await openRow(NO_PHOTO);
    // Una gracia de una falla de 2020, cuando no existía GRACIA_COBRO_DIAS: los alumnos activos de
    // cualquier instante posterior no se saben, y la foto no se toma.
    const user = await createTestUser();
    const start = (await owner.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0]!.now;
    try {
      await owner.query(
        `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency,
           current_period_start, current_period_end, last_renewal_failed_at, created_at)
         values ($1, 'manual', $2, 'monthly', 'in_grace', 'MXN', '2020-02-10', '2020-03-10', '2020-03-10', '2020-01-01')`,
        [user.id, `it-sin-foto-${user.id}`],
      );
      await owner.query("call private.nightly_rollup()");
      const runs = await owner.query<{ status: string; error: string; details: { photo_missing?: number[]; photos: { failed?: Record<string, string> } } }>(
        "select status::text, error, details from public.job_runs where started_at > $1::timestamptz and job = 'period_transition'",
        [start],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]!.status).toBe("failed");
      expect(runs.rows[0]!.details.photo_missing).toContain(NO_PHOTO);
      expect(Object.keys(runs.rows[0]!.details.photos.failed ?? {})).toContain(String(NO_PHOTO));
      expect(runs.rows[0]!.error).toMatch(/photos failed: .*photo missing: /);
      expect(await status(NO_PHOTO)).toBe("open");
    } finally {
      await deleteTestUsers([user]);
      await owner.query("delete from public.job_runs where started_at > $1::timestamptz and job <> 'period_transition'", [start]);
    }
  });
});
