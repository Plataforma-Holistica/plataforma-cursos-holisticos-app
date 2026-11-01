import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { actAs, asFinance, clearPeriodsBefore, connect, financePerson, outcomeOf, retire, waitBehind, type Finance } from "./helpers/finance";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Las retenciones contra la base local, en lo que una transacción revertida no puede mostrar (T-409): que el maestro guarde sus datos mientras finanzas libera.
// Guardar y liberar toman el mismo candado de saldo: el segundo espera al primero, y lo liberado es lo que se vio. Y que al confirmar de verdad, lo que corre al
// confirmar acepta lo que se calculó.
//
// Usa meses de 2042, que ninguna otra prueba usa, y una maestra con cuenta, sin curso: su liquidación nace de un bono a mano que pasa el mínimo. Como la 58, quita
// antes las filas abiertas desde el arranque, cierra sus meses de verdad y al terminar quita lo suyo con las guardias apagadas; la auditoría se queda.

const FIRST = 204201;
const OURS = [204201, 204202];
const AMOUNT = 100_000;

let owner: Client;
let finance: Finance;
let teacher: string;
let person: { id: string; sessionId: string };
let rule: string;
const emails: string[] = [];

const sealed = (length: number) => Buffer.from(`010001${"ab".repeat(12 + length + 16)}`, "hex");

const call = async (client: Client, sql: string, args: unknown[]) => (await client.query<{ r: Record<string, unknown> }>(`select ${sql} as r`, args)).rows[0]!.r;

/** Guardar como la maestra, en la transacción que se le pase, sin confirmar. */
async function save(client: Client, seen: number): Promise<unknown> {
  await asServer(client, person.id, person.sessionId);
  const answer = await call(client, "pg_catalog.jsonb_build_object('answer', private.tax_profile_save($1, $2::integer, $3, $4, '612', 'person', $5, '7771', 1))", [
    teacher,
    seen,
    sealed(13),
    sealed(20),
    sealed(18),
  ]);
  await asOwner(client);
  return answer.answer;
}

const payoutOf = async (period: number) =>
  (
    await owner.query<{ status: string; subtotal: string; vat: string; income: string; vat_withheld: string; net: string; version: number | null; rule: string | null }>(
      `select status::text, subtotal_cents::text as subtotal, vat_cents::text as vat, income_tax_withheld_cents::text as income, vat_withheld_cents::text as vat_withheld,
              net_cents::text as net, withholding_profile_version as version, withholding_rule_id::text as rule
       from public.payouts where period_id = $1 and teacher_id = $2`,
      [period, teacher],
    )
  ).rows[0];

const seenRelease = (period: number) =>
  asFinance(finance, async (client) => ((await call(client, "private.finance_payouts($1)", [period])) as { release: { fingerprint: string } }).release.fingerprint);

beforeAll(async () => {
  owner = await connect();
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2042 en la base local: pnpm db:reset");
  await clearPeriodsBefore(owner, FIRST);
  finance = await financePerson(emails);

  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const entered = await testServices().signIn(jar, who, freshOrigin());
  if (entered.kind !== "entered") throw new Error(`No entró: ${entered.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass" || !check.claims.sessionId) throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  person = { id: who.id, sessionId: check.claims.sessionId };

  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
  teacher = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id::text", [who.id])).rows[0]!.id;
  await owner.query("select set_config('app.actor_id', $1, true)", [who.id]);
  await owner.query("insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')", [who.id]);
  await owner.query("select set_config('app.actor_id', '', true)");
  rule = (await owner.query<{ id: string }>(
    `insert into public.withholding_rules (tax_regime_code, payee_kind, vat_rate, income_tax_withholding_rate, vat_withholding_rate, effective_from, note)
     values ('612', 'person', 0.16, 0.10, 0.106667, '2000-01-01', 'prueba') returning id::text`,
  )).rows[0]!.id;
  for (const period of OURS) await owner.query("select private.open_period($1)", [period]);
  await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
  await owner.query(
    `update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 1, pool_bps = 6000 where period_id = any($1::int[])`,
    [OURS],
  );
  await owner.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
  await owner.query(
    `insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
     select 'nightly_rollup', p, 'succeeded', now() - interval '1 hour', now() - interval '1 hour', now() - interval '59 minutes', '{"mode": "full"}'::jsonb
     from unnest($1::int[]) p`,
    [OURS],
  );
  await owner.query("commit");
  for (const period of OURS) {
    await asFinance(finance, (client) => outcomeOf(client, "rehearse_close", period));
    const closed = await asFinance(finance, (client) => outcomeOf(client, "close_period", period));
    if (closed.outcome !== "closed") throw new Error(`no cerró ${period}: ${JSON.stringify(closed)}`);
  }
  for (const period of OURS) {
    await asFinance(finance, (client) => call(client, "private.capture_bonus($1, 'discretionary', $2, $3, 'Bono de la prueba.')", [teacher, AMOUNT, period]));
  }
});

afterAll(async () => {
  await owner.query("begin");
  try {
    await owner.query("set local session_replication_role = replica");
    await owner.query("delete from public.teacher_balance_entries where teacher_id = $1", [teacher]);
    await owner.query("delete from public.payout_status_events where payout_id in (select id from public.payouts where period_id = any($1::int[]))", [OURS]);
    await owner.query("delete from public.payouts where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.bonuses where period_id = any($1::int[])", [OURS]);
    await owner.query("update public.payout_periods set close_run_id = null where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.close_run_teacher_totals where close_run_id in (select id from public.close_runs where period_id = any($1::int[]))", [OURS]);
    await owner.query("delete from private.close_exports where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.close_runs where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.job_runs where period_id = any($1::int[])", [OURS]);
    await owner.query("delete from public.payout_periods where period_id = any($1::int[]) or period_id = 204203", [OURS]);
    await owner.query("delete from private.teacher_tax_profiles where teacher_id = $1", [teacher]);
    await owner.query("delete from public.withholding_rules where id = $1", [rule]);
    await owner.query("delete from public.consents where profile_id = $1", [person.id]);
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

describe("guardar los datos y liberar, de verdad", () => {
  it("sin datos, liberar lo dice y no escribe nada más que la liquidación vacía", async () => {
    const answer = await asFinance(finance, (client) => outcomeOf(client, "release_payouts", FIRST));
    expect(answer).toMatchObject({ outcome: "tax_data_missing", teachers: [teacher] });
    expect((await payoutOf(FIRST))?.status).toBe("calculated");
  });

  it("guardar mientras se ve: liberar espera su candado, y como la vista cambió, no libera", async () => {
    const seen = await seenRelease(FIRST);
    const saver = await connect();
    const releaser = await connect();
    try {
      await saver.query("begin");
      expect(await save(saver, 0)).toBe("saved");
      await releaser.query("begin");
      await actAs(releaser, finance);
      const waiting = call(releaser, "private.release_payouts($1, $2)", [FIRST, seen]);
      await waitBehind(owner, saver, 1);
      await saver.query("commit");
      expect(await waiting).toMatchObject({ outcome: "preview_changed" });
      await retire(releaser, finance);
      await releaser.query("rollback");
    } finally {
      await saver.query("rollback").catch(() => undefined);
      await releaser.query("rollback").catch(() => undefined);
      await saver.end();
      await releaser.end();
    }
  });

  it("guardar mientras se libera: guardar espera, y lo liberado se queda con la versión que se vio, al confirmar de verdad", async () => {
    const seen = await seenRelease(FIRST);
    const saver = await connect();
    const releaser = await connect();
    try {
      await releaser.query("begin");
      await actAs(releaser, finance);
      expect(await call(releaser, "private.release_payouts($1, $2)", [FIRST, seen])).toMatchObject({ outcome: "released", awaiting_invoice: 1 });
      await retire(releaser, finance);
      await saver.query("begin");
      const waiting = save(saver, 1);
      await waitBehind(owner, releaser, 1);
      await releaser.query("commit");
      expect(await waiting).toBe("saved");
      await saver.query("commit");
    } finally {
      await saver.query("rollback").catch(() => undefined);
      await releaser.query("rollback").catch(() => undefined);
      await saver.end();
      await releaser.end();
    }
    const paid = await payoutOf(FIRST);
    expect(paid).toMatchObject({ status: "awaiting_invoice", version: 1, rule, subtotal: String(AMOUNT), vat: "16000", income: "10000", vat_withheld: "10666", net: "95334" });
  });

  it("el mes siguiente ya usa la versión nueva", async () => {
    const released = await asFinance(finance, (client) => outcomeOf(client, "release_payouts", OURS[1]));
    expect(released).toMatchObject({ outcome: "released" });
    expect((await payoutOf(OURS[1]!))?.version).toBe(2);
  });
});
