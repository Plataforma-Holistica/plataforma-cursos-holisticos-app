import "server-only";

import { GoTrueAdminApi, GoTrueClient } from "@supabase/supabase-js";

import { getEnv } from "@/config/env";

import { failureFromResponse, type AuthFailure } from "./auth-errors";

// Con qué se habla con Supabase Auth (TRD §8.10). Nada de aquí sale del adaptador.
//
// Hay tres maneras, y cada una existe por una razón:
//
// - El SDK, con un cliente de un solo uso, para lo que es una sola petición que crea
//   sesión o manda un correo: registrar, pedir la recuperación, entrar y canjear. El
//   cliente se crea para esa llamada y se tira: el SDK guarda en memoria la sesión de quien
//   entra, y en un cliente compartido la del último quedaría a la mano del siguiente.
// - El SDK de administración, con la llave secreta, para cuatro cosas. Una recibe solo un
//   correo: invitar al pedir el registro. Las otras tres actúan sobre la cuenta de un
//   enlace recién canjeado: fijar la primera contraseña al completar el registro, el
//   segundo camino de la recuperación, y borrar unos metadatos tan grandes que no dejan
//   usar la sesión.
// - La llamada directa, para lo que el SDK haría con estado o con reintentos: renovar
//   (reintenta hasta 30 segundos), cerrar una sesión, guardar la contraseña recuperada y
//   preguntar si una sesión vive.
//
// Toda petición lleva tiempo límite. Sin él, un servidor de identidad lento detiene cada
// petición de la aplicación que pase por aquí.

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const authUrl = () => `${withoutTrailingSlash(getEnv().NEXT_PUBLIC_SUPABASE_URL)}/auth/v1`;

/** Lo que tarda como mucho una llamada del SDK. */
const SDK_TIMEOUT_MS = 8_000;
/** Lo que tarda como mucho una llamada directa, si quien llama no dice otra cosa. */
const DIRECT_TIMEOUT_MS = 5_000;

// Con esta versión Auth contesta los errores con el código como texto en `code`.
const API_VERSION = "2024-01-01";

export type Fetch = typeof fetch;

/** Un `fetch` con tiempo límite y sin caché, respetando la señal de quien llama. */
function bounded(base: Fetch, timeoutMs: number): Fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal, cache: "no-store" });
  };
}

function publicHeaders(): Record<string, string> {
  const key = getEnv().NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

const withoutSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/** Un cliente de Auth para una sola llamada. No se guarda ni se comparte. */
export function oneShotClient(base?: Fetch): GoTrueClient {
  return new GoTrueClient({
    url: authUrl(),
    headers: publicHeaders(),
    fetch: bounded(base ?? fetch, SDK_TIMEOUT_MS),
    ...withoutSession,
  });
}

let verifier: GoTrueClient | undefined;

/**
 * El cliente con el que `claims.ts` comprueba la firma de un token. Es el único que se
 * comparte, y solo sirve para eso: nunca entra nadie con él, así que no guarda la sesión
 * de nadie.
 */
export function verifierClient(): GoTrueClient {
  verifier ??= oneShotClient();
  return verifier;
}

let admin: GoTrueAdminApi | undefined;

/**
 * La API de administración de Auth, con la llave secreta. Salta todo permiso: se usa en un
 * solo archivo (`auth.ts`: `requestSignUp`, `setFirstPassword`, `setRecoveredPassword` y
 * `slimDown`), y una prueba de arquitectura lo exige.
 */
export function adminApi(base?: Fetch): GoTrueAdminApi {
  if (base) return newAdminApi(base);
  admin ??= newAdminApi(fetch);
  return admin;
}

function newAdminApi(base: Fetch): GoTrueAdminApi {
  const key = getEnv().SUPABASE_SECRET_KEY;
  return new GoTrueAdminApi({
    url: authUrl(),
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    fetch: bounded(base, SDK_TIMEOUT_MS),
  });
}

export type AuthCall = { ok: true; body: unknown } | { ok: false; failure: AuthFailure };

export interface AuthCallOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** La ruta bajo `/auth/v1`, con su consulta. */
  path: string;
  /** El token de acceso de la persona, cuando la llamada es a su nombre. */
  accessToken?: string;
  body?: unknown;
  timeoutMs?: number;
  fetch?: Fetch | undefined;
}

/**
 * Una llamada directa a Auth: un solo intento, con tiempo límite. Nunca lanza. Lo que no
 * sea una respuesta que se entienda es «no hubo respuesta».
 */
export async function callAuth(options: AuthCallOptions): Promise<AuthCall> {
  const request = bounded(options.fetch ?? fetch, options.timeoutMs ?? DIRECT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    ...publicHeaders(),
    "X-Supabase-Api-Version": API_VERSION,
  };
  if (options.accessToken !== undefined) headers.Authorization = `Bearer ${options.accessToken}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const response = await request(`${authUrl()}${options.path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // Un cuerpo que no es JSON (la página de error de una pasarela) no dice nada.
        return response.ok
          ? { ok: false, failure: { kind: "unreachable" } }
          : { ok: false, failure: failureFromResponse(response.status, null) };
      }
    }
    return response.ok ? { ok: true, body } : { ok: false, failure: failureFromResponse(response.status, body) };
  } catch {
    return { ok: false, failure: { kind: "unreachable" } };
  }
}
