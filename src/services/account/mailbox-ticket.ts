import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { isSecureSite, type CookieJar, type CookieReader } from "@/adapters/supabase/auth-cookies";
import { getEnv } from "@/config/env";

// El resguardo del buzón (TRD §9.2, fila «Invitaciones»). Quien abre un enlace del correo y
// fija su contraseña demostró, en ese navegador y en ese momento, que controla el buzón. El
// servidor deja ahí un secreto de un solo uso y le pasa a la base su huella
// (`private.claim_account()`). Aceptar una invitación de administración pide ese secreto:
// quien ya sabía la contraseña, quien la cambia por fuera o quien tiene una entrada en
// vuelo no lo tiene.
//
// El secreto lo genera siempre el servidor: nunca se toma de lo que mande el navegador al
// reclamar. La cookie no va firmada, porque lo que vale es que su huella esté en la base, y
// se deja a toda cuenta que reclama, tenga o no una invitación: así no dice nada de nadie.

/** Lo más que dura la cookie, diga lo que diga el parámetro. */
export const MAILBOX_TICKET_MAX_AGE_LIMIT = 86_400;

/** Treinta y dos bytes en base64url, sin relleno. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface MailboxTicket {
  /** Lo que se queda en el navegador. */
  readonly secret: string;
  /** Su huella, que es lo único que llega a la base: SHA-256 en hexadecimal. */
  readonly print: string;
}

const printOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

export function createMailboxTickets(overrides: { secure?: () => boolean; random?: (size: number) => Buffer } = {}) {
  const secure = overrides.secure ?? (() => isSecureSite(getEnv().NEXT_PUBLIC_SITE_URL));
  const random = overrides.random ?? randomBytes;
  // Con https, el prefijo impide que otro subdominio la plante. En local un navegador lo
  // rechazaría: es la misma regla de la cookie de sesión.
  const name = () => (secure() ? "__Host-plataforma-resguardo" : "plataforma-resguardo");
  const options = (maxAge: number) => ({ httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge }) as const;

  /** Un resguardo nuevo. Todavía no está en ningún lado. */
  function issueTicket(): MailboxTicket {
    const secret = random(32).toString("base64url");
    return { secret, print: printOf(secret) };
  }

  /**
   * Lo deja en el navegador, por los segundos que diga la base. Sin una duración que valga
   * no deja nada: la persona prueba su buzón otra vez cuando haga falta. Solo desde una
   * acción o una ruta.
   */
  function keepTicket(jar: CookieJar, ticket: MailboxTicket, maxAgeSeconds: number | null): boolean {
    if (maxAgeSeconds === null || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1) return false;
    jar.set(name(), ticket.secret, options(Math.min(maxAgeSeconds, MAILBOX_TICKET_MAX_AGE_LIMIT)));
    return true;
  }

  /** La huella del resguardo que trae el navegador, o nulo si no trae uno con su forma. */
  function readTicketPrint(reader: CookieReader): string | null {
    const value = reader.get(name());
    return value !== undefined && SECRET.test(value) ? printOf(value) : null;
  }

  /** Lo borra: ya se gastó al aceptar. */
  function dropTicket(jar: CookieJar): void {
    if (jar.get(name()) !== undefined) jar.set(name(), "", options(0));
  }

  return { issueTicket, keepTicket, readTicketPrint, dropTicket };
}

export const { issueTicket, keepTicket, readTicketPrint, dropTicket } = createMailboxTickets();
