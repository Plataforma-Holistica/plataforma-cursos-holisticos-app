import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actAs, clearPeriodsBefore, connect, financePerson, retire, waitBehind, type Finance } from "./helpers/finance";
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

const call = async (client: Client, fn: string, arg: unknown) =>
  (await client.query<{ r: Record<string, unknown> }>(`select private.${fn}($1) as r`, [arg])).rows[0]!.r;

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
    await owner.query("delete from private.rollup_requests where period_id = $1", [current]);
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

  it("el recálculo pedido lo corre el corredor: un recálculo completo del periodo, y el pedido termina con su corrida", async () => {
    // El mes en curso, abierto (va al final: un mes abierto antes de 2038 detendría sus cierres).
    openedCurrent = (await owner.query("select 1 from public.payout_periods where period_id = $1", [current])).rowCount === 0;
    await owner.query("begin");
    await owner.query("select set_config('app.actor_kind', 'system', true)");
    await owner.query("select private.open_period($1)", [current]);
    await owner.query("commit");
    const answer = await asServer((client) => call(client, "request_rollup", current));
    expect(answer.outcome).toBe("requested");
    const requested = answer.request_id as string;
    // El `pg_cron` local también lo puede tomar: lo que importa es que termine, y cómo.
    await owner.query("call private.run_rollup_requests()");
    const deadline = Date.now() + 90_000;
    let row: { status: string; mode: string | null; run_status: string | null } | undefined;
    for (;;) {
      row = (await owner.query<{ status: string; mode: string | null; run_status: string | null }>(
        `select q.status, j.details ->> 'mode' as mode, j.status::text as run_status
         from private.rollup_requests q left join public.job_runs j on j.id = q.job_run_id where q.id = $1`,
        [requested],
      )).rows[0];
      if (row && (row.status === "succeeded" || row.status === "failed")) break;
      if (Date.now() > deadline) throw new Error(`el pedido no terminó: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(row).toEqual({ status: "succeeded", mode: "full", run_status: "succeeded" });
  });
});
