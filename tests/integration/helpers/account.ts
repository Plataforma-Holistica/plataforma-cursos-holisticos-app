import { randomInt } from "node:crypto";

import { Client } from "pg";

import { createAccountServices, type AccountDependencies } from "@/services/account/account";
import { buckets, fingerprint, type Fingerprint } from "@/services/account/fingerprint";
import { resolveOrigin, type RequestOrigin } from "@/services/account/origin";
import type { FailureCode } from "@/services/error-reporting/server";

import { knownUser, type KnownUser } from "./auth";
import { localOwnerUrl } from "./local";
import { claimAccount, ownerQuery } from "./users";

// Lo que las pruebas de los servicios de cuenta necesitan alrededor: servicios armados con
// una dirección de fiar y sin esperas, personas con la cuenta reclamada, y cómo mirar y
// atrasar el freno y los contadores como dueño de la base.

export interface TestServices extends ReturnType<typeof createAccountServices> {
  /** Los fallos de operación que el servicio reportó, en orden. */
  readonly reported: FailureCode[];
  /** Cuánto pidió esperar cada llamada, por el piso del tiempo de respuesta. */
  readonly slept: number[];
}

/**
 * Servicios como los ve la aplicación en un despliegue: la cabecera de la dirección se
 * cree. El reloj del piso de tiempo está quieto, así que cada llamada «espera» el piso
 * entero sin tardar nada.
 */
export function testServices(overrides: Partial<AccountDependencies> = {}): TestServices {
  const reported: FailureCode[] = [];
  const slept: number[] = [];
  const services = createAccountServices({
    proxyTrusted: () => true,
    timing: {
      now: () => 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    },
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { ...services, reported, slept };
}

/** Una dirección nueva en cada llamada, de un rango reservado para pruebas (198.18.0.0/15). */
export function freshOrigin(): RequestOrigin {
  return { realIp: `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`, userAgent: "Pruebas de integración" };
}

/** Una cuenta con contraseña conocida, correo confirmado y la marca de contraseña apagada. */
export async function claimedUser(): Promise<KnownUser> {
  const user = await knownUser();
  await claimAccount(user.id);
  return user;
}

/**
 * Toma, desde otra sesión de la base, el candado consultivo de esa huella: lo mismo que
 * hace un intento que va delante y no ha terminado. Devuelve cómo soltarlo.
 */
export async function holdLock(print: Fingerprint): Promise<() => Promise<void>> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  await owner.query("select pg_advisory_lock($1::bigint)", [print.lockKey.toString()]);
  // Cerrar la sesión suelta el candado.
  return () => owner.end();
}

/**
 * Como `holdProfile`, pero se suelta sola en cuanto el primero que esperaba esa fila se
 * rindió: el siguiente intento la consigue. `released` termina cuando la soltó, y falla si
 * nadie llegó a esperarla: así una prueba de «el segundo intento lo logra» no pasa sin
 * que haya habido un primero que falló.
 */
export async function holdProfileUntilFirstGivesUp(userId: string): Promise<{ released: Promise<void> }> {
  const release = await holdProfile(userId);
  const watch = async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    let first: string | null = null;
    try {
      while (Date.now() < deadline) {
        const rows = await ownerQuery<{ waiter: string }>(
          `select pid::text || ' ' || query_start::text as waiter from pg_stat_activity
           where usename = 'app_service' and wait_event_type = 'Lock' order by query_start limit 1`,
        );
        const waiter = rows[0]?.waiter ?? null;
        if (first === null) first = waiter;
        else if (waiter !== first) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Nadie esperó la fila del perfil, o el primero nunca se rindió.");
    } finally {
      await release();
    }
  };
  return { released: watch() };
}

/** Vacía el freno y los contadores: cada caso empieza de cero. */
export async function clearThrottle(): Promise<void> {
  await ownerQuery("delete from private.login_throttles");
  await ownerQuery("delete from private.rate_limit_counters");
}

export interface PairKeys {
  account: Fingerprint;
  ip: Fingerprint;
}

/** Las huellas que el servicio calcula para un correo y una petición. */
export function keysOf(email: string, origin: RequestOrigin, proxyTrusted = true): PairKeys {
  return { account: fingerprint("account", email.toLowerCase()), ip: resolveOrigin(origin, proxyTrusted).ip };
}

export interface PairRow {
  failed_count: number;
  locked_until: Date | null;
  last_failed_at: Date | null;
  last_success_at: Date | null;
}

/** La fila del freno de un par, o `null` si no existe. */
export async function pairOf(keys: PairKeys): Promise<PairRow | null> {
  const rows = await ownerQuery<PairRow & Record<string, unknown>>(
    `select failed_count, locked_until, last_failed_at, last_success_at
     from private.login_throttles where account_key = $1 and ip_key = $2`,
    [Buffer.from(keys.account.bytes), Buffer.from(keys.ip.bytes)],
  );
  return rows[0] ?? null;
}

/** Atrasa todas las fechas de un par: así pasa el tiempo sin esperar. */
export async function agePair(keys: PairKeys, seconds: number): Promise<void> {
  await ownerQuery(
    `update private.login_throttles
     set locked_until = locked_until - make_interval(secs => $3),
         last_failed_at = last_failed_at - make_interval(secs => $3),
         last_success_at = last_success_at - make_interval(secs => $3)
     where account_key = $1 and ip_key = $2`,
    [Buffer.from(keys.account.bytes), Buffer.from(keys.ip.bytes), seconds],
  );
}

/** Escribe la fila de un par tal cual, como si el servicio la hubiera dejado antes. */
export async function seedPair(keys: PairKeys, row: Partial<PairRow>): Promise<void> {
  await ownerQuery(
    `insert into private.login_throttles (account_key, ip_key, failed_count, locked_until, last_failed_at, last_success_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      Buffer.from(keys.account.bytes),
      Buffer.from(keys.ip.bytes),
      row.failed_count ?? 0,
      row.locked_until ?? null,
      row.last_failed_at ?? null,
      row.last_success_at ?? null,
    ],
  );
}

/** Lo contado en la hora en curso para un cubo. Cero si no hay fila. */
export async function hitsOf(bucket: string): Promise<number> {
  const rows = await ownerQuery<{ hits: number }>(
    "select hits from private.rate_limit_counters where bucket = $1 and window_start = date_trunc('hour', now())",
    [bucket],
  );
  return rows[0]?.hits ?? 0;
}

/** Deja un cubo con esa cuenta en la hora en curso. */
export async function seedHits(bucket: string, hits: number): Promise<void> {
  await ownerQuery(
    "insert into private.rate_limit_counters (bucket, window_start, hits) values ($1, date_trunc('hour', now()), $2)",
    [bucket, hits],
  );
}

/** Cuántas filas hay en total en las dos tablas del freno: para ver que una negación no deja nada. */
export async function throttleRows(): Promise<number> {
  const rows = await ownerQuery<{ n: number }>(
    `select (select count(*) from private.login_throttles)::int
          + (select count(*) from private.rate_limit_counters)::int as n`,
  );
  return rows[0]?.n ?? -1;
}

export const signInBuckets = (keys: PairKeys) => ({
  ip: buckets.signInIp(keys.ip),
  account: buckets.signInAccount(keys.account),
});

/** Las sesiones que la aplicación tiene anotadas para una cuenta. */
export async function notedSessions(userId: string): Promise<number> {
  const rows = await ownerQuery<{ n: number }>(
    "select count(*)::int as n from private.app_sessions where profile_id = $1",
    [userId],
  );
  return rows[0]?.n ?? -1;
}

/** Los cubos del registro de un correo desde una dirección. El cupo de correos va por buzón. */
export function registrationBuckets(mailbox: string, origin: RequestOrigin) {
  const print = fingerprint("mailbox", mailbox.toLowerCase());
  return {
    ip: buckets.signUpIp(resolveOrigin(origin, true).ip),
    mail: buckets.signUpMail(print),
    last: buckets.signUpMailLast(print),
  };
}

/** Los de la recuperación. Su cupo va por correo exacto. */
export function recoveryBuckets(email: string, origin: RequestOrigin) {
  const print = fingerprint("account", email.toLowerCase());
  return {
    ip: buckets.recoverIp(resolveOrigin(origin, true).ip),
    mail: buckets.recoverMail(print),
    last: buckets.recoverMailLast(print),
  };
}

/** Cuántas filas tiene un cubo, sea cual sea su ventana. */
export async function bucketRows(bucket: string): Promise<number> {
  const rows = await ownerQuery<{ n: number }>(
    "select count(*)::int as n from private.rate_limit_counters where bucket = $1",
    [bucket],
  );
  return rows[0]?.n ?? -1;
}

/** Atrasa la hora del último correo anotado en un cubo: así pasa la espera sin esperar. */
export async function ageLastMail(bucket: string, seconds: number): Promise<void> {
  await ownerQuery(
    "update private.rate_limit_counters set window_start = window_start - make_interval(secs => $2) where bucket = $1",
    [bucket, seconds],
  );
}

/** Anota un último correo en un cubo, hace `secondsAgo` segundos. */
export async function seedLastMail(bucket: string, secondsAgo = 0): Promise<void> {
  await ownerQuery(
    "insert into private.rate_limit_counters (bucket, window_start, hits) values ($1, clock_timestamp() - make_interval(secs => $2), 1)",
    [bucket, secondsAgo],
  );
}

/** Un parámetro de negocio entero, como lo tiene la base. */
export async function parameter(key: string): Promise<number> {
  const rows = await ownerQuery<{ value: number }>("select private.parameter_value($1) as value", [key]);
  const value = rows[0]?.value;
  if (typeof value !== "number") throw new Error(`El parámetro ${key} no es un número.`);
  return value;
}

/** Los identificadores de los tres textos vigentes que pide una cuenta, por tipo. */
export async function currentTextIds(): Promise<Record<"terms" | "student_privacy_notice" | "course_history_consent", string>> {
  const rows = await ownerQuery<{ doc_type: string; id: string }>(
    `select t.doc_type::text as doc_type, private.current_legal_document(t.doc_type)::text as id
     from unnest(array['terms', 'student_privacy_notice', 'course_history_consent']::public.legal_doc_type[]) as t (doc_type)`,
  );
  const ids = Object.fromEntries(rows.map((row) => [row.doc_type, row.id]));
  if (rows.length !== 3 || rows.some((row) => !row.id)) throw new Error("Falta un texto legal vigente: corre pnpm db:drafts.");
  return ids as Record<"terms" | "student_privacy_notice" | "course_history_consent", string>;
}

export interface ProfileRow {
  display_name: string | null;
  adult: boolean;
  pending: boolean;
  status: string;
}

export async function profileOf(userId: string): Promise<ProfileRow | null> {
  const rows = await ownerQuery<ProfileRow & Record<string, unknown>>(
    `select display_name, adult_declared_at is not null as adult, password_reset_required as pending, status::text as status
     from public.profiles where id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export interface ConsentRow {
  doc_type: string;
  action: string;
  origin: string;
  ip: string | null;
  user_agent: string | null;
}

/** Los consentimientos de una cuenta, ordenados por tipo. */
export async function consentsOf(userId: string): Promise<ConsentRow[]> {
  return ownerQuery<ConsentRow & Record<string, unknown>>(
    `select d.doc_type::text as doc_type, c.action::text as action, c.origin, host(c.ip) as ip, c.user_agent
     from public.consents c join public.legal_documents d on d.id = c.legal_document_id
     where c.profile_id = $1 order by d.doc_type::text, c.occurred_at`,
    [userId],
  );
}

/**
 * Toma, desde otra sesión de la base, el candado de la fila de un perfil: lo que el
 * servicio intente escribir ahí espera hasta su tiempo límite. Devuelve cómo soltarlo.
 */
export async function holdProfile(userId: string): Promise<() => Promise<void>> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  await owner.query("begin");
  await owner.query("select 1 from public.profiles where id = $1 for update", [userId]);
  return async () => {
    await owner.query("rollback").catch(() => undefined);
    await owner.end();
  };
}
