import "server-only";

import {
  createClient,
  isAuthRetryableFetchError,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { z } from "zod";

import { getEnv } from "@/config/env";

import { ExpiredClaimsError, IdentityUnavailableError, UnverifiedClaimsError } from "./errors";

// Quién es la persona, a partir del token de su sesión (TRD §8.10 y §9.2).
//
// El token se verifica antes de usarlo, con `getClaims()` del SDK: firma y vigencia contra
// las claves públicas del proyecto, sin ir al servidor de identidad en cada petición. Eso
// no detecta una sesión revocada; donde importe se usa `getUser()`, que llega con la
// entrega que lo necesite.

/** Lo que el adaptador sabe de una persona después de verificar su token. */
export interface VerifiedClaims {
  /** El identificador de su perfil: el mismo que `auth.users.id`. */
  readonly userId: string;
  /** `aal2` si la sesión pasó el segundo factor. */
  readonly aal: "aal1" | "aal2";
  readonly sessionId: string | null;
}

// `getClaims()` solo mira la firma y la vigencia. Esto es lo que además se exige, para
// que un token bien firmado para otra cosa no pase por una persona.
const claimsSchema = z.looseObject({
  sub: z.uuid(),
  role: z.literal("authenticated"),
  aal: z.enum(["aal1", "aal2"]),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  // Segundos desde 1970. De aquí sale hasta cuándo sirven las claims ya verificadas.
  exp: z.number(),
  session_id: z.string().optional(),
  is_anonymous: z.boolean().optional(),
});

type Claims = z.infer<typeof claimsSchema>;

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

/** Valida la forma y el destino de unas claims. No dice nada de su firma. */
export function parseClaims(payload: unknown, expected: { issuer: string }): Claims | null {
  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const claims = parsed.data;
  if (withoutTrailingSlash(claims.iss) !== withoutTrailingSlash(expected.issuer)) return null;
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!audience.includes("authenticated")) return null;
  if (claims.is_anonymous === true) return null;
  return claims;
}

// Las claims que este módulo verificó, con el JSON que la base va a leer y el momento en
// que su token vence. Un objeto con la misma forma, armado en otro lado, no está aquí:
// `asUser` y `asServer` lo rechazan.
const verified = new WeakMap<object, { json: string; expiresAt: number }>();

export function isVerifiedClaims(value: unknown): value is VerifiedClaims {
  return typeof value === "object" && value !== null && verified.has(value);
}

/**
 * Lo que `db.ts` necesita de unas claims para abrir una transacción por esa persona.
 * Lanza si no las verificó este módulo, o si su token ya venció: un objeto guardado (en
 * una caché, en un flujo largo) no sigue sirviendo después de que la sesión caducó.
 */
export function readVerifiedClaims(claims: unknown): { json: string; claims: VerifiedClaims } {
  const entry = typeof claims === "object" && claims !== null ? verified.get(claims) : undefined;
  if (!entry) throw new UnverifiedClaimsError();
  if (Date.now() >= entry.expiresAt) throw new ExpiredClaimsError();
  return { json: entry.json, claims: claims as VerifiedClaims };
}

// El proyecto firma sus tokens con clave pública. Uno de clave compartida (HS256) o sin
// identificador de clave no se puede verificar aquí: el SDK le preguntaría al servidor de
// identidad, y eso es una petición saliente por cada token que alguien mande.
const ACCEPTED_ALGORITHMS = new Set(["ES256", "RS256"]);

/** Mira la cabecera del token, sin verificar nada: solo decide si vale la pena intentarlo. */
export function hasAcceptedAlgorithm(accessToken: string): boolean {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return false;
  try {
    const [header, body] = [parts[0], parts[1]].map(
      (part): unknown => JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")),
    );
    const isObject = (value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    // Un cuerpo que no es un objeto haría tropezar al SDK de otra forma que una firma mala.
    if (!isObject(header) || !isObject(body)) return false;
    const { alg, kid } = header as { alg?: unknown; kid?: unknown };
    return (
      typeof alg === "string" &&
      ACCEPTED_ALGORITHMS.has(alg) &&
      typeof kid === "string" &&
      kid !== ""
    );
  } catch {
    return false;
  }
}

let cached: SupabaseClient | undefined;

// Un solo cliente: guarda en memoria las claves públicas del proyecto. No lleva sesión de
// nadie (no persiste ni renueva), solo se le pasan tokens para verificar.
function client(): SupabaseClient {
  if (cached) return cached;
  const env = getEnv();
  cached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return cached;
}

/**
 * Verifica el token de acceso de una sesión. Devuelve `null` si no es válido, sin decir
 * por qué: firma, vigencia, emisor, audiencia o rol.
 *
 * Lanza `IdentityUnavailableError` si no se pudo saber: las claves públicas se bajan del
 * servidor de identidad, y si no responde, la persona no dejó de tener sesión.
 */
export async function verifyAccessToken(accessToken: string): Promise<VerifiedClaims | null> {
  if (!hasAcceptedAlgorithm(accessToken)) return null;
  let payload: unknown;
  try {
    const { data, error } = await client().auth.getClaims(accessToken);
    if (error) {
      if (isAuthRetryableFetchError(error)) throw new IdentityUnavailableError();
      return null;
    }
    if (!data) return null;
    payload = data.claims;
  } catch (error) {
    if (error instanceof IdentityUnavailableError) throw error;
    // Lo que el SDK lanza en vez de devolver es un fallo de red al pedir las claves.
    throw new IdentityUnavailableError();
  }

  const issuer = `${withoutTrailingSlash(getEnv().NEXT_PUBLIC_SUPABASE_URL)}/auth/v1`;
  const claims = parseClaims(payload, { issuer });
  if (!claims) return null;

  const result: VerifiedClaims = Object.freeze({
    userId: claims.sub,
    aal: claims.aal,
    sessionId: claims.session_id ?? null,
  });
  verified.set(result, { json: JSON.stringify(claims), expiresAt: claims.exp * 1000 });
  return result;
}
