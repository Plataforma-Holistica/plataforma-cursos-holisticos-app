import "server-only";

import { z } from "zod";

import { isSecureSite, type CookieJar, type CookieReader } from "@/adapters/supabase/auth-cookies";
import { getEnv } from "@/config/env";
import { parseEmail } from "@/domain/access/email";

import { returnOrNull } from "./navigation";

// El correo de un registro a medias (diseño, PA-14, variante «Revisa tu correo»). Al pedir
// el registro la pantalla siguiente dice a qué correo se mandó el enlace, y deja reenviarlo.
// Ese correo viaja en una cookie corta, no en la dirección de la página.
//
// No va firmada: es un dato de la propia persona, y nada se decide con ella. Quien la lee
// la trata como cualquier dato de fuera: lo que no sea exactamente lo que este código
// escribió cuenta como ausente, y el correo se vuelve a validar. La hora del último envío
// solo sirve para pintar el botón de reenviar; la espera de verdad la lleva el servicio.
//
// Lleva también a dónde iba quien se registró (FL-04: el plan elegido, la lección de un curso abierto), para volver ahí al completar
// la cuenta. Con eso sí se decide algo, una redirección, y por eso no se confía en lo guardado: el destino se valida contra la
// lista de destinos al escribirlo y otra vez al leerlo, y quien arma la salida lo vuelve a validar. Uno que no vale se lee como
// sin destino, sin tirar el correo.

export interface PendingRegistration {
  /** El correo, ya normalizado. */
  email: string;
  /** Cuándo se pidió el último envío, en milisegundos. */
  sentAt: number;
  /** A dónde iba, si iba a algún lado y la lista lo admite. Al guardar llega tal como vino: aquí se valida. */
  returnTo?: string;
}

/** Lo más que puede vivir: un día. La vida de verdad la pone quien la guarda (la del enlace). */
export const PENDING_REGISTRATION_MAX_AGE_LIMIT = 86_400;

const MAX_VALUE_LENGTH = 1_024;
/** Lo más que mide un destino anotado. El validador admite más, pero la cookie entera tiene que caber en su tope de lectura. */
const MAX_RETURN_LENGTH = 512;
// El destino no se revisa aquí: uno con otra forma no invalida el correo, se lee como ausente.
const stored = z.strictObject({ e: z.string(), t: z.number().int().nonnegative(), r: z.unknown().optional() });

/** El destino si es uno que este código anotaría: de la lista y dentro del tope. */
function notedReturn(input: unknown): string | null {
  if (typeof input !== "string" || input.length > MAX_RETURN_LENGTH) return null;
  const resolved = returnOrNull(input);
  // Solo vale tal como este código lo habría escrito: ya resuelto.
  return resolved !== null && resolved.length <= MAX_RETURN_LENGTH ? resolved : null;
}

const encode = (value: object): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export function createPendingRegistration(overrides: { secure?: () => boolean } = {}) {
  const secure = overrides.secure ?? (() => isSecureSite(getEnv().NEXT_PUBLIC_SITE_URL));
  // La misma regla de la cookie de sesión: con https, el prefijo impide que otro subdominio
  // la plante; en local un navegador lo rechazaría.
  const name = () => (secure() ? "__Host-plataforma-registro" : "plataforma-registro");
  const options = (maxAge: number) => ({ httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge }) as const;

  /**
   * Guarda a qué correo se le pidió el enlace. Solo desde una acción.
   * @param maxAgeSeconds Lo que dura el enlace: pasado eso ya no hay nada que revisar.
   */
  function rememberRegistration(jar: CookieJar, pending: PendingRegistration, maxAgeSeconds: number): void {
    const parsed = parseEmail(pending.email);
    if (!parsed.ok) return;
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > PENDING_REGISTRATION_MAX_AGE_LIMIT) return;
    const bare = encode({ e: parsed.email, t: pending.sentAt });
    const returnTo = notedReturn(pending.returnTo);
    const full = returnTo === null ? bare : encode({ e: parsed.email, t: pending.sentAt, r: returnTo });
    // Si con el destino no cabe en lo que después se lee, va sin él: perder el destino es volver al inicio; perder la cookie
    // deja a «Revisa tu correo» sin correo y a «Reenviar» sin a quién.
    jar.set(name(), full.length <= MAX_VALUE_LENGTH ? full : bare, options(maxAgeSeconds));
  }

  /** El registro a medias de este navegador, o nulo. */
  function readRegistration(reader: CookieReader): PendingRegistration | null {
    const value = reader.get(name());
    if (value === undefined || value === "" || value.length > MAX_VALUE_LENGTH) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const parsed = stored.safeParse(decoded);
    if (!parsed.success) return null;
    const email = parseEmail(parsed.data.e);
    // Solo vale el correo tal como este código lo habría escrito: ya normalizado.
    if (!email.ok || email.email !== parsed.data.e) return null;
    const returnTo = notedReturn(parsed.data.r);
    return returnTo === null ? { email: email.email, sentAt: parsed.data.t } : { email: email.email, sentAt: parsed.data.t, returnTo };
  }

  /** La borra: la cuenta ya se completó en este navegador, o ese no era el correo. */
  function forgetRegistration(jar: CookieJar): void {
    if (jar.get(name()) !== undefined) jar.set(name(), "", options(0));
  }

  return { rememberRegistration, readRegistration, forgetRegistration };
}

export const { rememberRegistration, readRegistration, forgetRegistration } = createPendingRegistration();
