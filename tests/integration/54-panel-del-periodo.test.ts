import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actAs, clearPeriodsBefore, connect, financePerson, retire, SHOWN, waitBehind, type Finance } from "./helpers/finance";
import { createTestUser, deleteTestUsers, deleteTestUsersByEmail, ownerQuery, type TestUser } from "./helpers/users";

// El panel del periodo, el cierre desde la aplicación y su exportación (T-605; RF-705, RF-509, RF-408)
// contra la base local, en lo que una transacción revertida no puede mostrar: el servidor (`app_service`,
// con el tope de 10 s de `db.ts`) ensaya y cierra, y la exportación se escribe y se comprueba al confirmar
// de verdad; el nombre de un maestro que alguien cambia mientras se cierra espera al cierre; descargar deja
// la auditoría; y el recálculo pedido lo corre el corredor de verdad, con sus `commit`.
//
// Usa meses de 2038, que ninguna otra prueba usa, con dos maestros sin curso: su consumo y sus nombres se
// escriben con la sesión en réplica (sin guardias ni claves), como el alumno y su cobro. Antes de empezar
// quita las filas abiertas desde el arranque a las que nada apunta y exige que no quede ninguna otra; al
// terminar quita lo suyo con las guardias apagadas. La auditoría de lo que hacen las funciones se queda.
// Para tomar el rol del servidor, el dueño lo recibe al empezar (sin heredarlo) y lo suelta al terminar,
// como el camino del equipo.

const FIRST = 203801;
const OURS = [203801, 203802, 203803];

let owner: Client;
let finance: Finance;
let student: TestUser;
let subscription: string;
const teachers: string[] = [];
const emails: string[] = [];
let current: number;
let openedCurrent = false;

/** En una transacción del servidor, a nombre de finanzas, con su tope por sentencia; confirmada. */
async function asServer<T>(work: (client: Client) => Promise<T>, client?: Client): Promise<T> {
  const own = client ?? (await connect());
  try {
    await own.query("begin");
    await actAs(own, finance);
    await own.query("set local role app_service");
    await own.query("set local statement_timeout = '10s'");
    const result = await work(own);
    await own.query("reset role");
    await retire(own, finance);
    await own.query("commit");
    return result;
  } finally {
    await own.query("rollback").catch(() => undefined);
    if (!client) await own.end();
  }
}

// Cerrar recibe el ensayo que se tenía a la vista (`SHOWN`, T-605 tercera solicitud).
const call = async (client: Client, fn: string, arg: unknown) =>
  (await client.query<{ r: Record<string, unknown> }>(`select private.${fn}(${fn === "close_period" ? `$1, ${SHOWN}` : "$1"}) as r`, [arg])).rows[0]!.r;

/** El consumo y el cobro de un mes: el alumno paga 349.00 y ve a los dos maestros. */
async function monthOf(period: number): Promise<void> {
  const charge = randomUUID();
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  await owner.query(
    `insert into public.charges (id, profile_id, subscription_id, provider, provider_charge_id, plan, charged_at, period_id,
                                 allocation_start_period_id, currency, gross_cents, tax_cents, fx_rate_to_mxn, fx_source, gross_mxn_cents,
                                 net_of_tax_mxn_cents, iva_bps, fee_bps, revenue_net_mxn_cents, payment_method, country_code)
     values ($1, $2, $3, 'manual', $4, 'monthly', now(), $5, $5, 'MXN', 34900, 4814, 1, 'same_currency', 34900, 30086, 1600, 500, 28581,
             'card', 'MX')`,
    [charge, student.id, subscription, `it-${charge}`, period],
  );
  await owner.query(
    `insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
     values ($1, $2, $3, 'charge', 1, 1, 28581, 500, 'charge_date_v1')`,
    [charge, student.id, period],
  );
  for (const [n, teacher] of teachers.entries()) {
    await owner.query(
      `insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                        lesson_duration_seconds, covered_seconds, half_points)
       values ($1, $2, gen_random_uuid(), gen_random_uuid(), $3, gen_random_uuid(), 100, 100, $4)`,
      [period, student.id, teacher, n + 1],
    );
  }
  await owner.query("commit");
}

const nameOf = async (teacher: string) =>
  (await owner.query<{ name: string }>("select display_name as name from public.published_teachers where teacher_id = $1", [teacher]))
    .rows[0]!.name;

beforeAll(async () => {
  owner = await connect();
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2038 en la base local: pnpm db:reset");
  await clearPeriodsBefore(owner, FIRST);

  finance = await financePerson(emails);
  student = await createTestUser();
  subscription = randomUUID();
  await ownerQuery(
    `insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
     values ($1, $2, 'manual', $3, 'monthly', 'pending', 'MXN')`,
    [subscription, student.id, `it-${subscription}`],
  );
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  for (const name of ["Maestra Panel Uno", "Maestra Panel Dos"]) {
    const id = (await owner.query<{ id: string }>("insert into public.teachers (status) values ('invited') returning id::text")).rows[0]!.id;
    await owner.query("insert into public.published_teachers (teacher_id, slug, display_name) values ($1, $2, $3)", [
      id,
      `it-panel-${id.slice(0, 8)}`,
      name,
    ]);
    teachers.push(id);
  }
  await owner.query("commit");

  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
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
  current = (await owner.query<{ p: number }>("select private.period_of(now())::int as p")).rows[0]!.p;
  await owner.query("commit");
  for (const period of OURS) await monthOf(period);
});

afterAll(async () => {
  await owner.query("begin");
  try {
    await owner.query("set local session_replication_role = replica");
    // Todos los pedidos de la prueba son de esta persona de finanzas, también los que un caso fallido dejó.
    await owner.query("delete from private.rollup_requests where requested_by = $1", [finance.person.id]);
    await owner.query("delete from public.job_runs where period_id = $1 and started_at >= now() - interval '1 hour'", [current]);
    await owner.query(
      "delete from public.payout_status_events where payout_id in (select id from public.payouts where period_id = any($1::int[]))",
      [OURS],
    );
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
    await owner.query("delete from public.charges where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_periods where period_id = any($1::int[]) or period_id = 203804", [OURS]);
    if (openedCurrent) await owner.query("delete from public.payout_periods where period_id = $1", [current]);
    await owner.query("delete from public.published_teachers where teacher_id = any($1::uuid[])", [teachers]);
    await owner.query("delete from public.teachers where id = any($1::uuid[])", [teachers]);
    await owner.query("set local session_replication_role = origin");
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
  if (student) await deleteTestUsers([student]);
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
  await ownerQuery("revoke app_service from postgres");
  await owner.end();
});

describe("el cierre desde la aplicación, de verdad", () => {
  it("el servidor ensaya y cierra; la exportación se escribe y se comprueba al confirmar, y suma lo mismo que el cierre", async () => {
    expect((await asServer((client) => call(client, "rehearse_close", FIRST))).outcome).toBe("rehearsed");
    const closed = await asServer((client) => call(client, "close_period", FIRST));
    expect(closed.outcome).toBe("closed");

    const exported = await owner.query<{ rows: number; ok: boolean; total: string; written: string }>(
      `select e.row_count as rows,
              e.content = private.close_export_csv(e.close_run_id, e.minimum_payout_cents)
                and e.sha256 = sha256(convert_to(e.content, 'UTF8')) as ok,
              (select sum(replace((regexp_match(l, ',(-?[0-9]+\\.[0-9]{2}),(-?[0-9]+\\.[0-9]{2}),(sí|no)?$'))[1], '.', '')::bigint)
               from regexp_split_to_table(rtrim(e.content, E'\\r\\n'), E'\\r\\n') with ordinality as x (l, n) where n > 1)::text as total,
              (select sum(total_cents) from public.payout_teacher_totals where period_id = $1)::text as written
       from private.close_exports e where e.close_run_id = $2`,
      [FIRST, closed.close_run_id],
    );
    expect(exported.rows).toEqual([{ rows: 2, ok: true, total: exported.rows[0]!.written, written: exported.rows[0]!.written }]);
    expect(Number(exported.rows[0]!.written)).toBeGreaterThan(0);
  });

  it("un nombre que cambia mientras se cierra espera al cierre, y la exportación lleva el nombre como estaba al cerrar", async () => {
    expect((await asServer((client) => call(client, "rehearse_close", 203802))).outcome).toBe("rehearsed");
    const before = await nameOf(teachers[0]!);
    const closer = await connect();
    const renamer = await connect();
    try {
      await closer.query("begin");
      await actAs(closer, finance);
      await closer.query("set local role app_service");
      expect((await call(closer, "close_period", 203802)).outcome).toBe("closed");

      await renamer.query("begin");
      await renamer.query("set local session_replication_role = replica");
      const renamed = renamer.query("update public.published_teachers set display_name = 'Otro nombre' where teacher_id = $1", [
        teachers[0],
      ]);
      await waitBehind(owner, closer, 1);
      await closer.query("reset role");
      await retire(closer, finance);
      await closer.query("commit");
      await renamed;
      await renamer.query("commit");
    } finally {
      await closer.query("rollback").catch(() => undefined);
      await renamer.query("rollback").catch(() => undefined);
      await closer.end();
      await renamer.end();
    }
    const content = (await owner.query<{ content: string }>("select content from private.close_exports where period_id = 203802")).rows[0]!
      .content;
    expect(content).toContain(`"${before}"`);
    expect(content).not.toContain("Otro nombre");
    await owner.query("begin");
    await owner.query("set local session_replication_role = replica");
    await owner.query("update public.published_teachers set display_name = $2 where teacher_id = $1", [teachers[0], before]);
    await owner.query("commit");
  });

  it("descargar por el servidor da el contenido con su huella y deja la auditoría", async () => {
    const run = (await owner.query<{ id: string }>("select close_run_id::text as id from public.payout_periods where period_id = $1", [FIRST]))
      .rows[0]!.id;
    const before = (await owner.query<{ n: number }>(
      "select count(*)::int as n from public.audit_log where action = 'close_exports.download' and entity_id = $1",
      [run],
    )).rows[0]!.n;
    const answer = await asServer((client) => call(client, "close_export_download", run));
    const stored = (await owner.query<{ content: string; sha: string }>(
      "select content, encode(sha256, 'hex') as sha from private.close_exports where close_run_id = $1",
      [run],
    )).rows[0]!;
    expect(answer).toMatchObject({ outcome: "ok", filename: "cierre-2038-01.csv", rows: 2, content: stored.content, sha256: stored.sha });
    const after = await owner.query<{ n: number; actor: string }>(
      `select count(*)::int as n, max(actor_id::text) as actor from public.audit_log
       where action = 'close_exports.download' and entity_id = $1`,
      [run],
    );
    expect(after.rows[0]).toEqual({ n: before + 1, actor: finance.person.id });
  });

  describe("el corredor de los pedidos de recálculo, de verdad", { timeout: 120_000 }, () => {
    // El `pg_cron` local también corre el corredor cada minuto: cada caso espera a que el pedido llegue a lo
    // que espera, lo corra quien lo corra. De las 08:00 a las 09:30 UTC el corredor no empieza nada: los casos
    // que necesitan que empiece (o que no empiece por otra razón) terminan sin probar en esa pausa y en los
    // tres minutos antes. Cada llamada al corredor va en su propia conexión, que se cierra: así, si lanza, su
    // candado de sesión no se queda tomado.
    const paused = async () =>
      (await owner.query<{ p: boolean }>(
        "select private.rollup_requests_paused(now()) or private.rollup_requests_paused(now() + interval '3 minutes') as p",
      )).rows[0]!.p;
    const state = async (id: string) =>
      (await owner.query<{ status: string; error: string | null; mode: string | null; run_status: string | null; after: boolean | null }>(
        `select q.status, q.error, j.details ->> 'mode' as mode, j.status::text as run_status, j.started_at >= q.started_at as after
         from private.rollup_requests q left join public.job_runs j on j.id = q.job_run_id where q.id = $1`,
        [id],
      )).rows[0]!;
    async function runner(): Promise<void> {
      const client = await connect();
      try {
        await client.query("call private.run_rollup_requests()");
      } finally {
        await client.end();
      }
    }
    async function settle(id: string, done: (status: string) => boolean) {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const row = await state(id);
        if (done(row.status)) return row;
        if (Date.now() > deadline) throw new Error(`el pedido no llegó: ${JSON.stringify(row)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    async function until(id: string, done: (status: string) => boolean) {
      await runner();
      return settle(id, done);
    }
    /** Un pedido escrito a mano, con la sesión en réplica (sin auditoría). */
    async function byHand(period: number, status = "pending", startedAgo?: string): Promise<string> {
      await owner.query("begin");
      await owner.query("set local session_replication_role = replica");
      const id = (await owner.query<{ id: string }>(
        `insert into private.rollup_requests (period_id, requested_by, status, started_at)
         values ($1, $2, $3, case when $4::interval is null then null else now() - $4::interval end) returning id::text`,
        [period, finance.person.id, status, startedAgo ?? null],
      )).rows[0]!.id;
      await owner.query("commit");
      return id;
    }
    const forget = (id: string) => owner.query("delete from private.rollup_requests where id = $1", [id]);
    /** El periodo en curso, forzado a un estado con la sesión en réplica, dentro de la transacción de `client`. */
    async function force(client: Client, status: string): Promise<void> {
      await client.query("set local session_replication_role = replica");
      await client.query(
        "update public.payout_periods set status = $2::public.period_status, entered_closing_at = case when $2::text = 'open' then null else now() end where period_id = $1",
        [current, status],
      );
      await client.query("set local session_replication_role = origin");
    }
    /**
     * La corrida del pedido no se abre: otra conexión inserta, sin confirmar, una corrida viva del periodo (que la
     * revisión de corridas vivas del corredor no ve), el corredor queda esperando en `open_job_run` y, al
     * confirmarla, su corrida no se abre. Esa corrida empieza un minuto después, para que el corredor la pudiera
     * confundir con la suya: está viva (y es completa). Con `close`, esa conexión además cierra el periodo antes de
     * confirmar.
     */
    async function runnerLosesTheRun(close: boolean) {
      const blocker = await connect();
      let live: string | undefined;
      let id: string | undefined;
      // Señuelos terminados que tampoco son su corrida: una del periodo que no es completa (después), una
      // completa del periodo de antes de marcar el pedido, y una completa de otro periodo (después).
      const decoys = (await owner.query<{ id: string }>(
        `insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
         values ('nightly_rollup', $1, 'succeeded', now() + interval '1 minute', now() + interval '1 minute', now() + interval '2 minutes',
                 '{"mode": "dirty"}'),
                ('nightly_rollup', $1, 'succeeded', now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '1 minute',
                 '{"mode": "full"}'),
                ('nightly_rollup', $2, 'succeeded', now() + interval '1 minute', now() + interval '1 minute', now() + interval '2 minutes',
                 '{"mode": "full"}')
         returning id::text`,
        [current, FIRST],
      )).rows.map((row) => row.id);
      try {
        await blocker.query("begin");
        live = (await blocker.query<{ id: string }>(
          `insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, details)
           values ('nightly_rollup', $1, 'running', now() + interval '1 minute', now(), '{"mode": "full"}') returning id::text`,
          [current],
        )).rows[0]!.id;
        if (close) await force(blocker, "closed");
        id = await byHand(current);
        const running = runner();
        await waitBehind(owner, blocker, 1);
        await blocker.query("commit");
        await running;
        return await settle(id, (status) => (close ? status === "failed" || status === "succeeded" : status !== "running"));
      } finally {
        await blocker.query("rollback").catch(() => undefined);
        await blocker.end();
        try {
          await owner.query("begin");
          await force(owner, "open");
          await owner.query("commit");
        } catch (error) {
          await owner.query("rollback");
          throw error;
        }
        await owner.query("delete from public.job_runs where id = any($1::uuid[])", [[...decoys, live].filter(Boolean)]);
        if (id) await forget(id);
      }
    }

    beforeAll(async () => {
      // El mes en curso, abierto (va al final: un mes abierto antes de 2038 detendría sus cierres). El recálculo
      // corre de verdad sobre él: si tiene consumo o marcas, no se corre.
      const busy = await owner.query(
        `select 1 from public.watch_rollup where period_id = $1 union all select 1 from private.rollup_dirty where period_id = $1 limit 1`,
        [current],
      );
      if ((busy.rowCount ?? 0) > 0) throw new Error("el mes en curso tiene consumo o marcas en la base local: pnpm db:reset");
      openedCurrent = (await owner.query("select 1 from public.payout_periods where period_id = $1", [current])).rowCount === 0;
      await owner.query("begin");
      await owner.query("select set_config('app.actor_kind', 'system', true)");
      await owner.query("select private.open_period($1)", [current]);
      await owner.query("commit");
    });

    it("con una consolidación viva, de cualquier periodo, no empieza, y el pedido sigue pendiente", async (ctx) => {
      if (await paused()) ctx.skip();
      const live = (await owner.query<{ id: string }>(
        `insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, details)
         values ('nightly_rollup', $1, 'running', now(), now(), '{"mode": "dirty"}') returning id::text`,
        [FIRST],
      )).rows[0]!.id;
      const id = await byHand(current);
      try {
        await runner();
        expect((await state(id)).status).toBe("pending");
      } finally {
        await forget(id);
        await owner.query("delete from public.job_runs where id = $1", [live]);
      }
    });

    it("mientras `pg_cron` diga que la consolidación de la noche corre, no empieza", async (ctx) => {
      if (await paused()) ctx.skip();
      const runid = (await owner.query<{ id: string }>(
        `insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, start_time)
         select jobid, 9000000000 + (random() * 1000000)::bigint, 0, 'postgres', 'postgres', command, 'running', now()
         from cron.job where jobname = 'nightly_rollup' returning runid::text as id`,
      )).rows[0]!.id;
      const id = await byHand(current);
      try {
        await runner();
        expect((await state(id)).status).toBe("pending");
      } finally {
        await forget(id);
        await owner.query("delete from cron.job_run_details where runid = $1", [runid]);
      }
    });

    it("un renglón de la noche que se quedó corriendo hace más de un día ya no lo detiene", async (ctx) => {
      if (await paused()) ctx.skip();
      const runid = (await owner.query<{ id: string }>(
        `insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, start_time)
         select jobid, 9000000000 + (random() * 1000000)::bigint, 0, 'postgres', 'postgres', command, 'running', now() - interval '2 days'
         from cron.job where jobname = 'nightly_rollup' returning runid::text as id`,
      )).rows[0]!.id;
      const id = await byHand(current);
      try {
        expect(await until(id, (status) => status === "succeeded" || status === "failed")).toMatchObject({ status: "succeeded", mode: "full" });
      } finally {
        await forget(id);
        await owner.query("delete from cron.job_run_details where runid = $1", [runid]);
      }
    });

    it("si otro corredor tiene el candado, no hace nada", async (ctx) => {
      if (await paused()) ctx.skip();
      const other = await connect();
      await other.query("select pg_advisory_lock(hashtextextended('rollup_requests', 0))");
      const id = await byHand(current);
      try {
        await runner();
        expect((await state(id)).status).toBe("pending");
      } finally {
        await forget(id);
        await other.end();
      }
    });

    it("uno que se quedó corriendo sin consolidación viva se da por fallido a los 15 minutos", async () => {
      const id = await byHand(current, "running", "20 minutes");
      try {
        expect(await until(id, (status) => status !== "running")).toMatchObject({ status: "failed", error: "abandoned" });
      } finally {
        await forget(id);
      }
    });

    it("uno de un periodo que la consolidación ya no recorre falla sin correr nada", async (ctx) => {
      if (await paused()) ctx.skip();
      const later = (await owner.query<{ p: number }>("select private.period_plus(private.period_of(now()), 2)::int as p")).rows[0]!.p;
      const existed = (await owner.query("select 1 from public.payout_periods where period_id = $1", [later])).rowCount === 1;
      await owner.query("begin");
      await owner.query("select set_config('app.actor_kind', 'system', true)");
      await owner.query("select private.open_period($1)", [later]);
      await owner.query("commit");
      try {
        const id = await byHand(later);
        expect(await until(id, (status) => status !== "pending")).toMatchObject({ status: "failed", error: "not_rollable", mode: null });
      } finally {
        await owner.query("delete from private.rollup_requests where period_id = $1", [later]);
        if (!existed) {
          await owner.query("begin");
          await owner.query("set local session_replication_role = replica");
          await owner.query("delete from public.payout_periods where period_id = $1", [later]);
          await owner.query("commit");
        }
      }
    });

    it("si su corrida no se abre (otra del periodo tenía el lugar), el pedido vuelve a pendiente", async (ctx) => {
      if (await paused()) ctx.skip();
      expect(await runnerLosesTheRun(false)).toMatchObject({ status: "pending", mode: null });
    });

    it("si el periodo se cerró mientras corría, el pedido falla sin darse por hecho", async (ctx) => {
      if (await paused()) ctx.skip();
      expect(await runnerLosesTheRun(true)).toMatchObject({ status: "failed", error: "closed" });
    });

    it("el pedido de finanzas lo corre el corredor: un recálculo completo, y el pedido termina con esa corrida", async (ctx) => {
      const answer = await asServer((client) => call(client, "request_rollup", current));
      expect(answer.outcome).toBe("requested");
      const id = answer.request_id as string;
      if (await paused()) ctx.skip();
      expect(await until(id, (status) => status === "succeeded" || status === "failed")).toEqual({
        status: "succeeded",
        error: null,
        mode: "full",
        run_status: "succeeded",
        after: true,
      });
    });
  });
});
