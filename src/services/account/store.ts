import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import type { PairState, ThrottleParams } from "@/domain/access/login-throttle";

import type { Fingerprint } from "./fingerprint";

// Lo que los servicios de cuenta leen y escriben del freno, los contadores y las sesiones
// anotadas (esquema §5.9 y §6.2). Cada función recibe la transacción ya abierta: quién
// actúa lo decidió quien la abrió.
//
// Se cuenta sin crear filas para decidir. Primero se toman candados consultivos de la
// transacción sobre la dirección y la cuenta; después se lee, el dominio decide, y solo si
// procede se escribe. Así una negación no deja nada, y dos intentos a la vez del mismo par
// se ordenan aunque su fila todavía no exista.

const MINUTE_SECONDS = 60;

/**
 * Toma, en el orden dado, los candados consultivos de esas huellas. Se sueltan solos al
 * terminar la transacción. El orden es siempre el mismo (dirección, cuenta, buzón) y va
 * antes de cualquier candado de fila: dos transacciones nunca se esperan en cruz.
 */
export async function lockAll(tx: Tx, prints: readonly Fingerprint[]): Promise<void> {
  for (const print of prints) {
    await tx.execute(sql`select pg_advisory_xact_lock(${print.lockKey}::bigint)`);
  }
}

export interface DbClock {
  /** La hora de la base con todos sus decimales, como texto: así vuelve a ella sin perder nada. */
  readonly text: string;
  /** La misma, para el dominio. Una fecha de JavaScript llega al milisegundo. */
  readonly date: Date;
}

const clockRow = z.object({ text: z.string().min(1), date: z.date() });

/** La hora de la base en este instante, no la del inicio de la transacción. Se lee después de los candados. */
export async function dbClock(tx: Tx): Promise<DbClock> {
  const [row] = await tx.query(sql`select c.t::text as text, c.t as date from (select clock_timestamp() as t) as c`, clockRow);
  if (!row) throw new Error("La base no devolvió su hora.");
  return row;
}

const paramsRow = z.object({
  threshold: z.number().int(),
  base_minutes: z.number().int(),
  max_minutes: z.number().int(),
  forget_minutes: z.number().int(),
  trust_days: z.number().int(),
  hourly_cap: z.number().int(),
});

/**
 * Los parámetros del freno (00-fundamentos §4), ya en lo que pide el dominio. Tres vienen
 * en minutos. Uno que falte o que no sea un entero lanza: nadie pasa.
 */
export async function loadThrottleParams(tx: Tx): Promise<ThrottleParams> {
  const [row] = await tx.query(
    sql`select
          private.parameter_value('INTENTOS_ANTES_DE_FRENO') as threshold,
          private.parameter_value('FRENO_ESPERA_BASE') as base_minutes,
          private.parameter_value('FRENO_ESPERA_TOPE') as max_minutes,
          private.parameter_value('FRENO_OLVIDO') as forget_minutes,
          private.parameter_value('FRENO_CONFIANZA_DIAS') as trust_days,
          private.parameter_value('TOPE_INTENTOS_HORA') as hourly_cap`,
    paramsRow,
  );
  if (!row) throw new Error("La base no devolvió los parámetros del freno.");
  return {
    threshold: row.threshold,
    baseWaitSeconds: row.base_minutes * MINUTE_SECONDS,
    maxWaitSeconds: row.max_minutes * MINUTE_SECONDS,
    forgetAfterSeconds: row.forget_minutes * MINUTE_SECONDS,
    trustDays: row.trust_days,
    hourlyCap: row.hourly_cap,
  };
}

export interface PairKeys {
  readonly account: Fingerprint;
  readonly ip: Fingerprint;
}

const pairRow = z.object({
  failed_count: z.number().int(),
  locked_until: z.date().nullable(),
  last_failed_at: z.date().nullable(),
  last_success_at: z.date().nullable(),
});

/** El par de esta cuenta y esta dirección, o `null` si nunca se vio. */
export async function readPair(tx: Tx, keys: PairKeys): Promise<PairState | null> {
  const [row] = await tx.query(
    sql`select failed_count, locked_until, last_failed_at, last_success_at
        from private.login_throttles
        where account_key = ${keys.account.bytes} and ip_key = ${keys.ip.bytes}`,
    pairRow,
  );
  if (!row) return null;
  return {
    failedCount: row.failed_count,
    lockedUntil: row.locked_until,
    lastFailedAt: row.last_failed_at,
    lastSuccessAt: row.last_success_at,
  };
}

/** Deja el par exactamente como dice el dominio, exista o no su fila. */
export async function writePair(tx: Tx, keys: PairKeys, pair: PairState): Promise<void> {
  await tx.execute(
    sql`insert into private.login_throttles
          (account_key, ip_key, failed_count, locked_until, last_failed_at, last_success_at)
        values (${keys.account.bytes}, ${keys.ip.bytes}, ${pair.failedCount}, ${pair.lockedUntil},
                ${pair.lastFailedAt}, ${pair.lastSuccessAt})
        on conflict (account_key, ip_key) do update set
          failed_count = excluded.failed_count,
          locked_until = excluded.locked_until,
          last_failed_at = excluded.last_failed_at,
          last_success_at = excluded.last_success_at`,
  );
}

const hitsRow = z.object({ hits: z.number().int() });

/** Lo contado en esa ventana para ese cubo. Cero si no hay fila. */
export async function readHits(tx: Tx, bucket: string, window: Date): Promise<number> {
  const [row] = await tx.query(
    sql`select hits from private.rate_limit_counters where bucket = ${bucket} and window_start = ${window}`,
    hitsRow,
  );
  return row?.hits ?? 0;
}

/** Suma uno a ese cubo en esa ventana. */
export async function countHit(tx: Tx, bucket: string, window: Date): Promise<void> {
  await tx.execute(
    sql`insert into private.rate_limit_counters as c (bucket, window_start, hits)
        values (${bucket}, ${window}, 1)
        on conflict (bucket, window_start) do update set hits = c.hits + 1`,
  );
}

/**
 * Resta el uno que se sumó por adelantado, en la misma ventana en que se sumó. Sin bajar
 * de cero: si entre tanto alguien borró o reinició la cuenta, no hay nada que restar.
 */
export async function uncountHit(tx: Tx, bucket: string, window: Date): Promise<void> {
  await tx.execute(
    sql`update private.rate_limit_counters set hits = hits - 1
        where bucket = ${bucket} and window_start = ${window} and hits > 0`,
  );
}

const mailParamsRow = z.object({
  ip_cap: z.number().int(),
  mail_cap: z.number().int(),
  resend_wait: z.number().int(),
});

export interface MailParams {
  /** Peticiones por hora desde una dirección (`TOPE_REGISTROS_HORA`). */
  ipHourlyCap: number;
  /** Correos por hora a un mismo destino (`TOPE_ENVIOS_CORREO_HORA`). */
  mailHourlyCap: number;
  /** `ESPERA_REENVIO`, que ya viene en segundos. */
  resendWaitSeconds: number;
}

/** Los parámetros de los topes de correo. Uno que falte o que no sea un entero lanza. */
export async function loadMailParams(tx: Tx): Promise<MailParams> {
  const [row] = await tx.query(
    sql`select
          private.parameter_value('TOPE_REGISTROS_HORA') as ip_cap,
          private.parameter_value('TOPE_ENVIOS_CORREO_HORA') as mail_cap,
          private.parameter_value('ESPERA_REENVIO') as resend_wait`,
    mailParamsRow,
  );
  if (!row) throw new Error("La base no devolvió los parámetros de los topes de correo.");
  return { ipHourlyCap: row.ip_cap, mailHourlyCap: row.mail_cap, resendWaitSeconds: row.resend_wait };
}

/** Los dos cubos del cupo de correos de un destino: la cuenta de la hora y el último envío. */
export interface MailBuckets {
  readonly hour: string;
  readonly last: string;
}

const lastRow = z.object({ sent: z.date() });

/** Cuándo salió el último correo anotado a ese destino, o nulo si no hay ninguno. */
export async function readLastSent(tx: Tx, bucket: string): Promise<Date | null> {
  const [row] = await tx.query(
    sql`select window_start as sent from private.rate_limit_counters
        where bucket = ${bucket} order by window_start desc limit 1`,
    lastRow,
  );
  return row?.sent ?? null;
}

/**
 * Anota un envío: suma uno a la hora y deja, como única fila de su cubo, la hora de este
 * correo. `sentText` es la hora de la base como texto, para que vuelva a ella entera.
 */
export async function noteSend(tx: Tx, cubes: MailBuckets, window: Date, sentText: string): Promise<void> {
  await countHit(tx, cubes.hour, window);
  await tx.execute(sql`delete from private.rate_limit_counters where bucket = ${cubes.last}`);
  await tx.execute(
    sql`insert into private.rate_limit_counters (bucket, window_start, hits)
        values (${cubes.last}, ${sentText}::timestamptz, 1)`,
  );
}

/**
 * Deshace ese envío, que al final no salió: resta el uno de su hora y borra su fila de
 * «último», solo si sigue siendo la suya. Si entre tanto se anotó otro, ese se queda.
 */
export async function unnoteSend(tx: Tx, cubes: MailBuckets, window: Date, sentText: string): Promise<void> {
  await uncountHit(tx, cubes.hour, window);
  await tx.execute(
    sql`delete from private.rate_limit_counters
        where bucket = ${cubes.last} and window_start = ${sentText}::timestamptz`,
  );
}

/**
 * Lo que deja en el freno una recuperación (`pairAfterRecovery`): este par como diga el
 * dominio, si se conoce su dirección; los demás pares de la cuenta sin confianza, con sus
 * fallos; y la cuenta de la hora de la cuenta, borrada.
 */
export async function trustAfterRecovery(tx: Tx, keys: PairKeys, pair: PairState | null, accountBucket: string): Promise<void> {
  const keep = pair !== null;
  if (pair) await writePair(tx, keys, pair);
  await tx.execute(
    sql`update private.login_throttles set last_success_at = null
        where account_key = ${keys.account.bytes} and last_success_at is not null
          and (not ${keep}::boolean or ip_key <> ${keys.ip.bytes})`,
  );
  await tx.execute(sql`delete from private.rate_limit_counters where bucket = ${accountBucket}`);
}

const stateRow = z.object({ state: z.string() });

/**
 * Anota la sesión para quien actúa en esta transacción. `startedText` es la hora de la base
 * que se leyó antes de preguntarle a Auth. Devuelve lo que contestó la base.
 */
export async function noteSession(tx: Tx, sessionId: string, startedText: string): Promise<string> {
  const [row] = await tx.query(
    sql`select private.note_session(${sessionId}::uuid, ${startedText}::timestamptz) as state`,
    stateRow,
  );
  return row?.state ?? "";
}

/** Si la aplicación reconoce esa sesión para quien actúa en esta transacción. */
export async function sessionRecognition(tx: Tx, sessionId: string): Promise<string> {
  const [row] = await tx.query(sql`select private.session_recognized(${sessionId}::uuid) as state`, stateRow);
  return row?.state ?? "";
}

/**
 * Fecha el cambio de contraseña de quien actúa en esta transacción y borra lo que tenía
 * anotado: desde aquí, una entrada que empezó antes ya no se anota. Devuelve lo que
 * contestó la base.
 */
export async function notePasswordChange(tx: Tx): Promise<string> {
  const [row] = await tx.query(sql`select private.note_password_change() as state`, stateRow);
  return row?.state ?? "";
}

/**
 * Etiqueta una sesión recién anotada con el navegador desde el que se abrió, para que su
 * dueña la reconozca en la lista de su cuenta. Devuelve lo que contestó la base.
 */
export async function tagSession(tx: Tx, sessionId: string, userAgent: string | null): Promise<string> {
  const [row] = await tx.query(
    sql`select private.tag_session(${sessionId}::uuid, ${userAgent}::text) as state`,
    stateRow,
  );
  return row?.state ?? "";
}

const openSessionRow = z.object({
  id: z.string(),
  opened_at: z.string(),
  last_active_at: z.string().nullable(),
  user_agent: z.string().nullable(),
  current: z.boolean(),
});

/** Una sesión abierta, como la tiene la base. Las horas, en UTC y en formato ISO. */
export interface NotedSession {
  id: string;
  openedAt: string;
  /**
   * La última vez que Auth renovó su token, o nulo si no lo dice. Es lo más cercano a una
   * «última actividad»: Auth no mueve esa fecha con cada uso, solo al renovar, así que va
   * hasta lo que dura un token de acceso por detrás.
   */
  lastActiveAt: string | null;
  userAgent: string | null;
  /** Es la sesión con la que se pide la lista. Lo dice la base, que compara identificadores. */
  current: boolean;
}

/**
 * Las sesiones abiertas de quien actúa en esta transacción: anotadas y vivas en Auth.
 * `askingSessionId` es la sesión con la que se pide, para decir cuál de ellas es.
 */
export async function listSessions(tx: Tx, askingSessionId: string): Promise<NotedSession[]> {
  const rows = await tx.query(
    sql`select s.session_id::text as id,
               to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as opened_at,
               to_char(s.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_active_at,
               s.user_agent,
               s.session_id = ${askingSessionId}::uuid as current
        from private.list_sessions() s`,
    openSessionRow,
  );
  return rows.map((row) => ({
    id: row.id,
    openedAt: row.opened_at,
    lastActiveAt: row.last_active_at,
    userAgent: row.user_agent,
    current: row.current,
  }));
}

/**
 * Cierra esa sesión de quien actúa, en Auth y en lo anotado. `askingSessionId` es la sesión
 * con la que se pide: la base exige que siga reconocida, y no la cierra por aquí. Devuelve
 * lo que contestó la base.
 */
export async function closeSession(tx: Tx, sessionId: string, askingSessionId: string): Promise<string> {
  const [row] = await tx.query(
    sql`select private.close_session(${sessionId}::uuid, ${askingSessionId}::uuid) as state`,
    stateRow,
  );
  return row?.state ?? "";
}

const closedRow = z.object({ closed: z.number().int().nullable() });

/**
 * Cierra todas las sesiones de quien actúa menos esa. Devuelve cuántas cerró en Auth, o
 * nulo si la base se negó: la que se queda tiene que ser suya, estar anotada y seguir viva.
 */
export async function closeOtherSessions(tx: Tx, keepSessionId: string): Promise<number | null> {
  const [row] = await tx.query(sql`select private.close_other_sessions(${keepSessionId}::uuid) as closed`, closedRow);
  return row?.closed ?? null;
}
