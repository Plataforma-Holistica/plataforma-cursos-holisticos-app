import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actAs, connect, financePerson, retire, waitBehind, type Finance } from "./helpers/finance";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// El libro de pagos (T-604, segunda solicitud) contra la base local, en lo que una transacción revertida no puede mostrar: dos personas de finanzas a la
// vez sobre la misma liquidación. Abrir, marcar, retener, soltar y devolver toman el periodo para escribir antes que la liquidación, así que van uno tras
// otro, y quien llega tarde se entera de lo que pasó: mientras una lectura no tenga su pago nadie más recibe la cuenta, y toda transferencia reportada entra
// al libro.
// Y dos marcas con la misma referencia en periodos distintos, que no comparten candado: el índice único decide, y la segunda entra con su conflicto.
//
// Usa meses de 2042, que ninguna otra prueba usa: los arma cerrados y liberados con las guardias apagadas, sin pasar por el cierre (eso lo prueban la 53 y
// la 55), y al terminar quita lo suyo de la misma manera; la auditoría se queda.

const OURS = [204201, 204202, 204203, 204204, 204205, 204206, 204207];

let owner: Client;
let financeA: Finance;
let financeB: Finance;
let financeC: Finance;
let teacher: string;
const emails: string[] = [];
const payout = new Map<number, string>();

const call = async (client: Client, sql: string, args: unknown[]) =>
  (await client.query<{ r: Record<string, unknown> }>(`select ${sql} as r`, args)).rows[0]!.r;

const statusOf = async (period: number) =>
  (await owner.query<{ status: string }>("select status::text from public.payouts where id = $1", [payout.get(period)])).rows[0]!.status;

const paymentsOf = async (period: number) =>
  (await owner.query<{ id: string; conflict: string | null; reference: string }>(
    "select id::text, conflict, reference from private.payout_payments where payout_id = $1 order by recorded_at",
    [payout.get(period)],
  )).rows;

const today = async () => (await owner.query<{ d: string }>("select private.release_day()::text as d")).rows[0]!.d;

/** Una llamada de finanzas en su propia transacción, ya confirmada. */
async function asOne<T>(finance: Finance, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query("begin");
    await actAs(client, finance);
    const result = await work(client);
    await retire(client, finance);
    await client.query("commit");
    return result;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

const open = (finance: Finance, period: number) => asOne(finance, (client) => call(client, "private.payout_account_open($1)", [payout.get(period)]));

/** Dos transacciones abiertas a la vez: la primera hace lo suyo sin confirmar, la segunda espera detrás, y se confirma la primera. */
async function race(
  first: Finance,
  firstWork: (client: Client) => Promise<Record<string, unknown>>,
  second: Finance,
  secondWork: (client: Client) => Promise<Record<string, unknown>>,
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  const a = await connect();
  const b = await connect();
  try {
    await a.query("begin");
    await actAs(a, first);
    const firstAnswer = await firstWork(a);
    await b.query("begin");
    await actAs(b, second);
    const waiting = secondWork(b);
    await waitBehind(owner, a, 1);
    await retire(a, first);
    await a.query("commit");
    const secondAnswer = await waiting;
    await retire(b, second);
    await b.query("commit");
    return [firstAnswer, secondAnswer];
  } finally {
    for (const client of [a, b]) {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  }
}

beforeAll(async () => {
  owner = await connect();
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2042 en la base local: pnpm db:reset");
  financeA = await financePerson(emails);
  financeB = await financePerson(emails);
  financeC = await financePerson(emails);

  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
  teacher = (await owner.query<{ id: string }>("insert into public.teachers (status) values ('invited') returning id::text")).rows[0]!.id;
  await owner.query("set local session_replication_role = replica");
  // Su CLABE rige desde hace una semana, con su aviso enviado, y ya se le llamó: aquí no se prueba la primera vez (eso, en la 68).
  await owner.query(
    `insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version,
                                               created_by, clabe_changed_at, clabe_effective_from)
     values ($1, 1, decode('010001' || repeat('ab', 41), 'hex'), decode('010001' || repeat('ab', 48), 'hex'), '612', 'person',
             decode('010001' || repeat('ab', 46), 'hex'), '7771', 1, $2, now() - interval '10 days', now() - interval '7 days')`,
    [teacher, financeA.person.id],
  );
  await owner.query(
    `insert into private.mail_outbox (idempotency_key, template, recipient, params, sent_at)
     select private.clabe_notice_key($1, x.clabe_changed_at), 'CO-27', 'maestra-87@prueba.test', '{"hours": 72}', x.clabe_changed_at
     from private.teacher_tax_profiles x where x.teacher_id = $1`,
    [teacher],
  );
  await owner.query(
    `insert into private.payout_account_calls (teacher_id, clabe_changed_at, spoke_with, called_at, recorded_by)
     select $1, clabe_changed_at, 'La maestra', now(), $2 from private.teacher_tax_profiles where teacher_id = $1`,
    [teacher, financeA.person.id],
  );
  for (const period of OURS) {
    const run = (
      await owner.query<{ id: string }>(
        `insert into public.close_runs (period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
         values ($1, 'rehearsal', 'failed', 'open', 'prueba', '{}', $2, 'prueba') returning id::text`,
        [period, financeA.person.id],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status, entered_closing_at, active_students, pool_bps,
                                          net_revenue_cents, student_pools_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents,
                                          close_run_id, closed_at, closed_by, payouts_released_at, payouts_released_by)
       select $1, b.starts_at, b.ends_at, 'America/Mexico_City', 'closed', now(), 0, 6000, 0, 0, 0, 0, 0, 0, $2, now(), $3, now(), $3
       from private.month_bounds($1, 'America/Mexico_City') b`,
      [period, run, financeA.person.id],
    );
    const id = (
      await owner.query<{ id: string }>(
        `insert into public.payouts (period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, net_cents, released_at, released_by)
         values ($1, $2, $3, 'ready_to_pay', 100000, 100000, 100000, now(), $4) returning id::text`,
        [period, teacher, run, financeA.person.id],
      )
    ).rows[0]!.id;
    payout.set(period, id);
  }
  await owner.query("set local session_replication_role = origin");
  await owner.query("commit");
});

afterAll(async () => {
  await owner.query("begin");
  try {
    await owner.query("set local session_replication_role = replica");
    const ids = [...payout.values()];
    await owner.query("delete from private.payout_requests where payout_id = any($1::uuid[])", [ids]);
    await owner.query("delete from private.payout_payments where payout_id = any($1::uuid[])", [ids]);
    await owner.query("delete from private.payout_account_reads where payout_id = any($1::uuid[])", [ids]);
    await owner.query("delete from private.payout_account_calls where teacher_id = $1", [teacher]);
    await owner.query("delete from public.payout_status_events where payout_id = any($1::uuid[])", [ids]);
    await owner.query("delete from public.payouts where id = any($1::uuid[])", [ids]);
    await owner.query("update public.payout_periods set close_run_id = null where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.close_runs where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_periods where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from private.mail_outbox where recipient = 'maestra-87@prueba.test'");
    await owner.query("delete from private.teacher_tax_profiles where teacher_id = $1", [teacher]);
    await owner.query("delete from public.teachers where id = $1", [teacher]);
    await owner.query("set local session_replication_role = origin");
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
  await owner.end();
});

const markWith = (period: number, read: string, reference: string, day: string) => (client: Client) =>
  call(client, "private.payout_mark_paid($1, $2, $3, $4::date, 100000)", [payout.get(period), read, reference, day]);

describe("dos personas de finanzas sobre la misma liquidación, de verdad", () => {
  it("marcar mientras otra retiene: retener espera, y una pagada ya no se retiene", async () => {
    const read = (await open(financeA, 204201)).read_id as string;
    const [marked, held] = await race(
      financeA,
      markWith(204201, read, "R-1", await today()),
      financeB,
      (client) => call(client, "private.hold_payout($1, 'Se investiga.', 'ready_to_pay')", [payout.get(204201)]),
    );
    expect(marked).toMatchObject({ outcome: "paid", status: "paid" });
    expect(held).toEqual({ outcome: "changed", status: "paid" });
    expect(await statusOf(204201)).toBe("paid");
  });

  it("retener mientras otra marca: marcar espera, la transferencia entra al libro, y la liquidación sigue retenida", async () => {
    const read = (await open(financeA, 204202)).read_id as string;
    const [held, marked] = await race(
      financeB,
      (client) => call(client, "private.hold_payout($1, 'Se investiga.', 'ready_to_pay')", [payout.get(204202)]),
      financeA,
      markWith(204202, read, "R-2", await today()),
    );
    expect(held).toMatchObject({ outcome: "held" });
    expect(marked).toMatchObject({ outcome: "conflict", conflict: "on_hold", status: "on_hold" });
    expect(await paymentsOf(204202)).toMatchObject([{ conflict: "on_hold", reference: "R-2" }]);
  });

  it("con una lectura abierta nadie más abre; dos marcas a la vez con esa lectura: la segunda espera, entra al libro, y no deja de estar pagada", async () => {
    const read = (await open(financeA, 204203)).read_id as string;
    expect(await open(financeB, 204203)).toMatchObject({ outcome: "already_open", read_by: financeA.person.id });
    const day = await today();
    const [first, second] = await race(financeA, markWith(204203, read, "R-3A", day), financeB, markWith(204203, read, "R-3B", day));
    expect(first).toMatchObject({ outcome: "paid" });
    expect(second).toMatchObject({ outcome: "conflict", conflict: "already_paid", status: "paid" });
    expect((await paymentsOf(204203)).map((row) => row.conflict)).toEqual([null, "already_paid"]);
  });

  it("abrir mientras otra marca: abrir espera, y una pagada no da la cuenta a una segunda transferencia", async () => {
    const read = (await open(financeA, 204204)).read_id as string;
    const [marked, opened] = await race(financeA, markWith(204204, read, "R-4", await today()), financeB, (client) =>
      call(client, "private.payout_account_open($1)", [payout.get(204204)]),
    );
    expect(marked).toMatchObject({ outcome: "paid" });
    expect(opened).toEqual({ outcome: "not_ready" });
  });

  it("dos personas confirman la misma devolución: la segunda espera, y un pago se devuelve una vez", async () => {
    const payment = (await paymentsOf(204204))[0]!.id;
    expect(await asOne(financeA, (client) => call(client, "private.payout_return_payment($1, 'El banco la regresó.')", [payment]))).toMatchObject({
      outcome: "proposed",
    });
    const [returned, again] = await race(
      financeB,
      (client) => call(client, "private.payout_return_payment($1, 'Confirmado con el banco.')", [payment]),
      financeC,
      (client) => call(client, "private.payout_return_payment($1, 'Confirmado con el banco.')", [payment]),
    );
    expect(returned).toMatchObject({ outcome: "returned", status: "payment_returned" });
    expect(again).toEqual({ outcome: "already_returned" });
    expect(await statusOf(204204)).toBe("payment_returned");
  });
});

describe("dos aperturas a la vez", () => {
  it("la segunda espera, y como la primera dejó una lectura sin pago, no recibe la cuenta", async () => {
    const [first, second] = await race(
      financeA,
      (client) => call(client, "private.payout_account_open($1)", [payout.get(204207)]),
      financeB,
      (client) => call(client, "private.payout_account_open($1)", [payout.get(204207)]),
    );
    expect(first).toMatchObject({ outcome: "ok", clabe_last4: "7771" });
    expect(first.read_id).toEqual(expect.any(String));
    expect(second).toMatchObject({ outcome: "already_open", read_by: financeA.person.id, own: false });
  });

  it("retener y soltar no la cierran: otra persona sigue sin la cuenta", async () => {
    expect(await asOne(financeB, (client) => call(client, "private.hold_payout($1, 'Se revisa.', 'ready_to_pay')", [payout.get(204207)]))).toMatchObject({ outcome: "held" });
    const seen = (await owner.query<{ h: string }>("select private.unhold_preview($1) ->> 'fingerprint' as h", [payout.get(204207)])).rows[0]!.h;
    expect(await asOne(financeB, (client) => call(client, "private.unhold_payout($1, null, $2)", [payout.get(204207), seen]))).toMatchObject({ to: "ready_to_pay" });
    expect(await open(financeB, 204207)).toMatchObject({ outcome: "already_open", read_by: financeA.person.id });
  });
});

describe("la misma referencia en dos periodos a la vez", () => {
  it("no comparten candado: el índice único decide, y la segunda entra con su conflicto y retiene", async () => {
    const readE = (await open(financeA, 204205)).read_id as string;
    const readF = (await open(financeB, 204206)).read_id as string;
    const day = await today();
    const a = await connect();
    const b = await connect();
    try {
      await a.query("begin");
      await actAs(a, financeA);
      expect(await markWith(204205, readE, "MISMA", day)(a)).toMatchObject({ outcome: "paid" });
      await b.query("begin");
      await actAs(b, financeB);
      const waiting = markWith(204206, readF, "misma", day)(b);
      await waitBehind(owner, a, 1);
      await retire(a, financeA);
      await a.query("commit");
      expect(await waiting).toMatchObject({ outcome: "conflict", conflict: "duplicate_reference", status: "on_hold" });
      await retire(b, financeB);
      await b.query("commit");
    } finally {
      for (const client of [a, b]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    }
    expect(await paymentsOf(204206)).toMatchObject([{ conflict: "duplicate_reference" }]);
    expect(await statusOf(204206)).toBe("on_hold");
  });
});
