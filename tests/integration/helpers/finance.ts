import { Client } from "pg";
import { expect } from "vitest";

import { claimedUser, freshOrigin, testServices } from "./account";
import { memoryJar, secondFactorFor, type KnownUser } from "./auth";
import { localOwnerUrl } from "./local";
import { asOwner, asSystem, reverted, teamStoreOn } from "./team";
import { totpCode } from "./totp";
import { completeAccountAsOwner } from "./users";

// Finanzas de verdad para el cierre y las liquidaciones (T-602, T-603): quien ensaya, cierra o libera
// es alguien con su segundo factor y su sesión del Auth local, y su código se da una vez al empezar,
// dentro de una transacción que se revierte. Su capacidad y su factor atado se escriben en cada
// transacción que actúa con la sesión en réplica (sin auditoría ni guardias) y se quitan igual antes de
// confirmar: dar capacidades queda en la auditoría, y las pruebas de base cuentan esos renglones. Lo que
// hacen las funciones de finanzas sí queda en la auditoría.

export interface Finance {
  person: KnownUser;
  factorId: string;
  sessionId: string;
  /** La capacidad con que actúa: finanzas, salvo en PA-89 (T-110), que pide configuración. */
  capability: "finance" | "config" | "content";
}

/** Una conexión del dueño, que no espera más de 20 s un candado. */
export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  await client.query("set lock_timeout = '20s'");
  return client;
}

/** Espera a que `count` conexiones estén detenidas por la de `first`. */
export async function waitBehind(owner: Client, first: Client, count: number): Promise<void> {
  const pid = (await first.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const deadline = Date.now() + 4_000;
  for (;;) {
    const rows = await owner.query<{ waiting: number }>(
      "select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))",
      [pid],
    );
    if ((rows.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error("La otra conexión no llegó a esperar.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Alguien de finanzas, de verdad, con su código dado hace un momento. Su correo se anota en `emails`. Con
 * `capability`, alguien con otra capacidad del equipo, de la misma manera (configuración, para PA-89).
 */
export async function financePerson(emails: string[], capability: Finance["capability"] = "finance"): Promise<Finance> {
  const person = await claimedUser();
  emails.push(person.email);
  await completeAccountAsOwner(person.id);
  const factor = await secondFactorFor(person);
  const jar = memoryJar();
  const entered = await testServices().signIn(jar, person, freshOrigin());
  if (entered.kind !== "entered") throw new Error(`La persona de prueba no entró: ${entered.kind}`);
  const sessionId = await reverted(async (tx) => {
    const services = testServices({ teamStore: teamStoreOn(tx) });
    await asSystem(tx);
    await tx.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2)", [person.id, capability]);
    await tx.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
      person.id,
      factor.factorId,
      person.email.toLowerCase(),
    ]);
    await asOwner(tx);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    const standing = await services.teamStanding(jar);
    if (standing.kind !== "team" || !standing.claims.sessionId) throw new Error("La persona de prueba no quedó en el equipo.");
    return standing.claims.sessionId;
  });
  return { person, factorId: factor.factorId, sessionId, capability };
}

/** En esta transacción, la persona tiene su capacidad (finanzas, o la que diga) y actúa con su sesión. */
export async function actAs(client: Client, finance: Finance): Promise<void> {
  await client.query("set local session_replication_role = replica");
  await client.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2)", [finance.person.id, finance.capability]);
  await client.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
    finance.person.id,
    finance.factorId,
    finance.person.email.toLowerCase(),
  ]);
  await client.query("set local session_replication_role = origin");
  await client.query("select set_config('app.actor_id', $1, true), set_config('app.actor_session', $2, true)", [
    finance.person.id,
    finance.sessionId,
  ]);
}

/** Antes de confirmar: se quita lo que `actAs` puso, sin dejarlo en la auditoría. */
export async function retire(client: Client, finance: Finance): Promise<void> {
  await client.query("set local session_replication_role = replica");
  await client.query("delete from private.admin_factors where profile_id = $1", [finance.person.id]);
  await client.query("delete from public.admin_capabilities where profile_id = $1", [finance.person.id]);
  await client.query("set local session_replication_role = origin");
}

/**
 * Una regla en 0 y los datos fiscales de un maestro, para las pruebas de liberar que no tratan de impuestos (T-409): con ellos las cifras no cambian. Dentro de una
 * transacción del dueño declarado sistema; la regla se quita al terminar, con `session_replication_role = replica`.
 */
export async function zeroWithholding(client: Client, teacher: string, by: string): Promise<void> {
  await client.query(
    `insert into public.withholding_rules (tax_regime_code, payee_kind, vat_rate, income_tax_withholding_rate, vat_withholding_rate, effective_from, note)
     values ('612', 'person', 0, 0, 0, '2000-01-01', 'regla en 0 de las pruebas')`,
  );
  await client.query(
    `insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by)
     values ($1, 1, decode('010001' || repeat('ab', 41), 'hex'), decode('010001' || repeat('ab', 48), 'hex'), '612', 'person', decode('010001' || repeat('ab', 46), 'hex'), '7771', 1, $2)`,
    [teacher, by],
  );
}

/** La respuesta de una función de finanzas del periodo: cerrar lleva el ensayo mostrado y liberar la huella vista. */
export const outcomeOf = async (client: Client, call: string, arg: unknown) =>
  (await client.query<{ r: Record<string, unknown> }>(`select private.${call}(${SEEN_BY[call] ?? "$1"}) as r`, [arg])).rows[0]!.r;

/**
 * Cerrar recibe el ensayo que se tenía a la vista (T-605, tercera solicitud): el último del periodo, como lo lee
 * la pantalla con la lectura del servidor. Las pruebas que no tratan de eso cierran con ese.
 */
export const SHOWN = "(private.finance_close($1) #>> '{rehearsal,run_id}')::uuid";

/**
 * Liberar recibe la huella de lo que se tenía a la vista (T-605, cuarta solicitud), como la lee PA-81 con la
 * lectura del servidor. Las pruebas que no tratan de eso liberan con esa.
 */
export const SEEN = "private.finance_payouts($1) #>> '{release,fingerprint}'";

const SEEN_BY: Record<string, string> = { close_period: `$1, ${SHOWN}`, release_payouts: `$1, ${SEEN}` };

/** Una llamada de finanzas confirmada: lo que se compruebe al confirmar corre de verdad. */
export async function asFinance<T>(finance: Finance, work: (client: Client) => Promise<T>): Promise<T> {
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

/**
 * El cierre va en orden desde el arranque: quita las filas abiertas desde el arranque, antes de `first`,
 * a las que nada apunta (las abre cada noche el paso a cierre del `pg_cron` local), y exige que no quede
 * ninguna otra abierta, en cierre o cerrada sin liberar (si no, `pnpm db:reset`).
 */
export async function clearPeriodsBefore(owner: Client, first: number): Promise<void> {
  await owner.query("begin");
  await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
  await owner.query(
    `delete from public.payout_periods p
     where p.status = 'open' and p.period_id < $1
       and p.period_id >= (select min(effective_period_id) from public.pool_tiers where canceled_at is null)
       and not exists (select 1 from public.charges c where c.allocation_start_period_id = p.period_id)
       and not exists (select 1 from public.watch_rollup w where w.period_id = p.period_id)
       and not exists (select 1 from public.anomaly_alerts a where a.period_id = p.period_id)
       and not exists (select 1 from public.consumption_exclusions x where x.period_id = p.period_id)
       and not exists (select 1 from public.close_runs r where r.period_id = p.period_id)
       and not exists (select 1 from public.bonuses b where b.period_id = p.period_id)
       and not exists (select 1 from public.payout_adjustments a where a.applied_period_id = p.period_id)`,
    [first],
  );
  await owner.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
  await owner.query("commit");
  const before = await owner.query(
    `select period_id from public.payout_periods
     where (status in ('open', 'closing') or payouts_released_at is null) and period_id < $1
       and period_id >= (select min(effective_period_id) from public.pool_tiers where canceled_at is null)`,
    [first],
  );
  if ((before.rowCount ?? 0) > 0) throw new Error("hay periodos abiertos o sin liberar desde el arranque en la base local: pnpm db:reset");
}
