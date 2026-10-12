import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { CookieJar, CookieOptions } from "@/adapters/supabase/auth-cookies";

import { totpCode } from "./totp";
import { ownerQuery, testEmail } from "./users";

// Lo que las pruebas del adaptador de Auth necesitan alrededor: un tarro de cookies en
// memoria, cuentas con una contraseña conocida, y un servidor de identidad que se puede
// hacer fallar.

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} para las pruebas de integración.`);
  return value;
};

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Auth con la llave secreta: para preparar y mirar, nunca como lo que se prueba. */
export const authAdmin = (): SupabaseClient =>
  createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), noSession);

/** Auth como lo ve cualquiera desde fuera: así llega quien no pasa por la Plataforma. */
export const authVisitor = (): SupabaseClient =>
  createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), noSession);

export interface CookieWrite {
  name: string;
  value: string;
  options: CookieOptions;
}

export interface MemoryJar extends CookieJar {
  readonly writes: CookieWrite[];
  /** Otro tarro con las mismas cookies: otra pestaña, o una copia de la cookie. */
  copy(): MemoryJar;
}

/** Un tarro en memoria que se porta como un navegador: una vida de cero borra. */
export function memoryJar(initial: ReadonlyMap<string, string> = new Map()): MemoryJar {
  const values = new Map(initial);
  const writes: CookieWrite[] = [];
  return {
    writes,
    get: (name) => values.get(name),
    set(name, value, options) {
      writes.push({ name, value, options });
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
    copy: () => memoryJar(values),
  };
}

export interface KnownUser {
  id: string;
  email: string;
  password: string;
}

/** Una cuenta con contraseña conocida, dada de alta por la API de administración. */
export async function knownUser(options: { confirmed?: boolean } = {}): Promise<KnownUser> {
  const email = testEmail();
  const password = `P-${randomUUID()}`;
  const created = await authAdmin().auth.admin.createUser({
    email,
    password,
    email_confirm: options.confirmed ?? true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`No se pudo dar de alta a la persona de prueba: ${created.error?.message}`);
  }
  return { id: created.data.user.id, email, password };
}

/** Cuántas sesiones tiene abiertas una cuenta, según la base de Auth. */
export async function sessionCount(userId: string): Promise<number> {
  const rows = await ownerQuery<{ count: string }>(
    "select count(*)::text as count from auth.sessions where user_id = $1",
    [userId],
  );
  return Number(rows[0]?.count);
}

export async function userIdOf(email: string): Promise<string> {
  const rows = await ownerQuery<{ id: string }>("select id from auth.users where email = $1", [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error("La cuenta de prueba no existe en Auth.");
  return id;
}

export interface RecordingFetch {
  fetch: typeof fetch;
  /** Las rutas que se pidieron, sin el servidor: `/auth/v1/token?grant_type=refresh_token`. */
  readonly calls: string[];
}

const pathOf = (input: Parameters<typeof fetch>[0]): string => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return `${url.pathname}${url.search}`;
};

/** El `fetch` de verdad, anotando qué se pidió. */
export function recordingFetch(): RecordingFetch {
  const calls: string[] = [];
  return {
    calls,
    fetch: (input, init) => {
      calls.push(pathOf(input));
      return fetch(input, init);
    },
  };
}

/**
 * Un servidor de identidad que falla en las rutas que coinciden con `match`, y que en las
 * demás es el de verdad. `respond` decide cómo falla: lanzar es un corte de red.
 */
export function failingFetch(match: RegExp, respond: () => Response | Promise<Response>): RecordingFetch {
  const calls: string[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const path = pathOf(input);
      calls.push(path);
      return match.test(path) ? Promise.resolve().then(respond) : fetch(input, init);
    },
  };
}

export const networkDown = (): Response => {
  throw new TypeError("fetch failed");
};

// Auth manda la versión con la que contesta: sin esa cabecera el SDK no lee el código.
export const tooManyRequests = (): Response =>
  Response.json(
    { code: "over_request_rate_limit", message: "x" },
    { status: 429, headers: { "x-supabase-api-version": "2024-01-01" } },
  );

export interface EnrolledFactor {
  factorId: string;
  /** El secreto de la aplicación de códigos: con él se calculan los códigos (`totpCode`). */
  secret: string;
}

/**
 * Le da a esa cuenta un segundo factor verificado, hablando directo con Auth como lo haría
 * su dueña. Verificarlo cierra las demás sesiones de primer nivel de la cuenta, así que va
 * antes de abrir las que la prueba necesite. La sesión con la que lo hizo se cierra.
 */
export async function secondFactorFor(user: Pick<KnownUser, "email" | "password">): Promise<EnrolledFactor> {
  const client = authVisitor();
  const entered = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (entered.error) throw new Error(`La persona de prueba no entró para dar de alta su factor: ${entered.error.code}`);
  const factor = await client.auth.mfa.enroll({ factorType: "totp" });
  if (factor.error) throw new Error(`El factor de prueba no se dio de alta: ${factor.error.code}`);
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: factor.data.id, code: totpCode(factor.data.totp.secret) });
  if (verified.error) throw new Error(`El factor de prueba no se verificó: ${verified.error.code}`);
  await client.auth.signOut({ scope: "local" });
  return { factorId: factor.data.id, secret: factor.data.totp.secret };
}

/** Los factores verificados de una cuenta, según la base de Auth. */
export async function verifiedFactors(userId: string): Promise<string[]> {
  const rows = await ownerQuery<{ id: string }>(
    "select id::text as id from auth.mfa_factors where user_id = $1 and status = 'verified' order by created_at",
    [userId],
  );
  return rows.map((row) => row.id);
}
