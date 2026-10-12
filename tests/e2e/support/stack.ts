import { knownUser, secondFactorFor, sessionCount, userIdOf, type KnownUser } from "../../integration/helpers/auth";
import { lastMailTo, mailsTo, tokenHashIn, waitForMails } from "../../integration/helpers/mailbox";
import {
  claimAccount,
  completeAccountAsOwner,
  deleteTestUsers,
  ownerQuery,
  testEmail,
} from "../../integration/helpers/users";

// Lo que las pruebas de extremo a extremo necesitan alrededor del navegador: personas en el
// Auth local, la base vista como su dueño y el buzón local. Son los mismos ayudantes de las
// pruebas de integración, los que no cargan código de la aplicación: aquí la aplicación es
// lo que se prueba, y corre en su propio proceso.

export {
  claimAccount,
  completeAccountAsOwner,
  lastMailTo,
  mailsTo,
  ownerQuery,
  secondFactorFor,
  sessionCount,
  testEmail,
  tokenHashIn,
  userIdOf,
  waitForMails,
};
export type { KnownUser };

/** El nombre de la cookie de sesión en local, que va por http y sin prefijo. */
export const SESSION_COOKIE = "plataforma-sesion";

/** El nombre de la cookie del registro a medias en local. */
export const PENDING_COOKIE = "plataforma-registro";

/**
 * Atrasa la hora del último correo anotado, a cualquier destino: así pasa `ESPERA_REENVIO`
 * sin esperar. Los cubos llevan la huella del destino, que una prueba no sabe calcular; por
 * eso van todos los de esa clase, que entre dos casos están vacíos.
 */
export async function ageLastMails(seconds: number): Promise<number> {
  const rows = await ownerQuery<{ bucket: string }>(
    `update private.rate_limit_counters set window_start = window_start - make_interval(secs => $1)
     where bucket like 'mail:signup:last:%' or bucket like 'mail:recover:last:%' returning bucket`,
    [seconds],
  );
  return rows.length;
}

/**
 * Atrasa la hora en que Auth dice haber mandado el último correo de recuperación de una
 * cuenta. Auth lleva su propia espera entre dos correos (`max_frequency`), además de la de
 * la aplicación: sin esto la segunda petición no manda nada, y el servicio lo reporta.
 */
export async function ageAuthRecoveryMail(email: string, seconds: number): Promise<void> {
  await ownerQuery("update auth.users set recovery_sent_at = recovery_sent_at - make_interval(secs => $2) where email = $1", [
    email,
    seconds,
  ]);
}

/**
 * Deja en `hits` los contadores por dirección de una puerta (`signup` o `recover`): así se
 * llega al tope sin pedir veinte correos. Devuelve cuántos cubos tocó.
 */
export async function fillAddressCounters(door: "signup" | "recover", hits: number): Promise<number> {
  const rows = await ownerQuery<{ bucket: string }>(
    "update private.rate_limit_counters set hits = $2 where bucket like $1 returning bucket",
    [`${door}:ip:%`, hits],
  );
  return rows.length;
}

/** Vacía el freno y los contadores: cada caso empieza de cero. */
export async function clearCounters(): Promise<void> {
  await ownerQuery("delete from private.login_throttles");
  await ownerQuery("delete from private.rate_limit_counters");
}

/** Un parámetro de negocio entero, como lo tiene la base. */
export async function parameter(key: string): Promise<number> {
  const rows = await ownerQuery<{ value: number }>("select private.parameter_value($1) as value", [key]);
  const value = rows[0]?.value;
  if (typeof value !== "number") throw new Error(`El parámetro ${key} no es un número.`);
  return value;
}

export interface Person extends KnownUser {
  /** El nombre con el que quedó su cuenta, si se completó. */
  name: string | null;
}

/**
 * Una persona con contraseña conocida y el correo confirmado.
 * - `complete`: reclamó su cuenta y la completó (nombre, edad y los tres textos). Entra.
 * - `claimed`: reclamó su cuenta, pero le falta completarla. Entra y ve PA-15.
 * - `unclaimed`: su contraseña no se fijó desde su buzón. No entra: se le manda a recuperar.
 */
export async function person(state: "complete" | "claimed" | "unclaimed" = "complete"): Promise<Person> {
  const user = await knownUser();
  if (state !== "unclaimed") await claimAccount(user.id);
  const name = state === "complete" ? "Ana de Prueba" : null;
  if (name !== null) await completeAccountAsOwner(user.id, name);
  return { ...user, name };
}

/** Los identificadores de los tres textos vigentes, por tipo. */
export async function currentTextIds(): Promise<Record<string, string>> {
  const rows = await ownerQuery<{ doc_type: string; id: string }>(
    `select t.doc_type::text as doc_type, private.current_legal_document(t.doc_type)::text as id
     from unnest(array['terms', 'student_privacy_notice', 'course_history_consent']::public.legal_doc_type[]) as t (doc_type)`,
  );
  if (rows.length !== 3 || rows.some((row) => !row.id)) throw new Error("Falta un texto legal vigente: corre pnpm db:drafts.");
  return Object.fromEntries(rows.map((row) => [row.doc_type, row.id]));
}

/** Los tipos de texto que una cuenta tiene aceptados y sin retirar. */
export async function grantedDocTypes(userId: string): Promise<string[]> {
  const rows = await ownerQuery<{ doc_type: string }>(
    `select distinct d.doc_type::text as doc_type
     from public.consents c join public.legal_documents d on d.id = c.legal_document_id
     where c.profile_id = $1 and c.action = 'granted' order by 1`,
    [userId],
  );
  return rows.map((row) => row.doc_type);
}

/** Olvida que la aplicación abrió las sesiones de una cuenta: quedan vivas en Auth, pero ya no se reconocen. */
export async function forgetNotedSessions(userId: string): Promise<number> {
  const rows = await ownerQuery<{ session_id: string }>(
    "delete from private.app_sessions where profile_id = $1 returning session_id::text as session_id",
    [userId],
  );
  return rows.length;
}

/**
 * Borra a todas las personas de prueba y vacía los contadores. Corre antes y después de
 * todas las pruebas: nada de lo que hacen debe quedar en la base.
 */
export async function removeLeftovers(): Promise<void> {
  const rows = await ownerQuery<{ id: string }>(
    "select id::text as id from auth.users where email ~ '^it-[0-9a-f-]{36}@prueba\\.test$'",
  );
  await deleteTestUsers(rows.map((row) => ({ id: row.id, email: "", accessToken: "" })));
  await clearCounters();
}
