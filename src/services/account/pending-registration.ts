import "server-only";

import { z } from "zod";

import { isSecureSite, type CookieJar, type CookieReader } from "@/adapters/supabase/auth-cookies";
import { getEnv } from "@/config/env";
import { parseEmail } from "@/domain/access/email";

// El correo de un registro a medias (diseño, PA-14, variante «Revisa tu correo»). Al pedir
// el registro la pantalla siguiente dice a qué correo se mandó el enlace, y deja reenviarlo.
// Ese correo viaja en una cookie corta, no en la dirección de la página.
//
// No va firmada: es un dato de la propia persona, y nada se decide con ella. Quien la lee
// la trata como cualquier dato de fuera: lo que no sea exactamente lo que este código
// escribió cuenta como ausente, y el correo se vuelve a validar. La hora del último envío
// solo sirve para pintar el botón de reenviar; la espera de verdad la lleva el servicio.

export interface PendingRegistration {
  /** El correo, ya normalizado. */
  email: string;
  /** Cuándo se pidió el último envío, en milisegundos. */
  sentAt: number;
}

/** Lo más que puede vivir: un día. La vida de verdad la pone quien la guarda (la del enlace). */
export const PENDING_REGISTRATION_MAX_AGE_LIMIT = 86_400;

const MAX_VALUE_LENGTH = 1_024;
const stored = z.strictObject({ e: z.string(), t: z.number().int().nonnegative() });

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
    const value = Buffer.from(JSON.stringify({ e: parsed.email, t: pending.sentAt }), "utf8").toString("base64url");
    jar.set(name(), value, options(maxAgeSeconds));
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
    return { email: email.email, sentAt: parsed.data.t };
  }

  /** La borra: la cuenta ya se completó en este navegador, o ese no era el correo. */
  function forgetRegistration(jar: CookieJar): void {
    if (jar.get(name()) !== undefined) jar.set(name(), "", options(0));
  }

  return { rememberRegistration, readRegistration, forgetRegistration };
}

export const { rememberRegistration, readRegistration, forgetRegistration } = createPendingRegistration();
