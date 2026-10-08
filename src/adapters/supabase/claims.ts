import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getEnv } from "@/config/env";

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

// Las claims que este módulo verificó, con el JSON que la base va a leer. Un objeto con la
// misma forma, armado en otro lado, no está aquí: `asUser` lo rechaza.
const verified = new WeakMap<object, string>();

export function isVerifiedClaims(value: unknown): value is VerifiedClaims {
  return typeof value === "object" && value !== null && verified.has(value);
}

/** El JSON de `request.jwt.claims` para unas claims verificadas. Solo lo usa `db.ts`. */
export function verifiedClaimsJson(claims: VerifiedClaims): string | undefined {
  return verified.get(claims);
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
 */
export async function verifyAccessToken(accessToken: string): Promise<VerifiedClaims | null> {
  if (accessToken === "") return null;
  let payload: unknown;
  try {
    const { data, error } = await client().auth.getClaims(accessToken);
    if (error || !data) return null;
    payload = data.claims;
  } catch {
    return null;
  }

  const issuer = `${withoutTrailingSlash(getEnv().NEXT_PUBLIC_SUPABASE_URL)}/auth/v1`;
  const claims = parseClaims(payload, { issuer });
  if (!claims) return null;

  const result: VerifiedClaims = Object.freeze({
    userId: claims.sub,
    aal: claims.aal,
    sessionId: claims.session_id ?? null,
  });
  verified.set(result, JSON.stringify(claims));
  return result;
}
