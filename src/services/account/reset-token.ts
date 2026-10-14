import "server-only";

import { randomBytes } from "node:crypto";

import { isSecureSite, type CookieJar, type CookieReader } from "@/adapters/supabase/auth-cookies";
import { getEnv } from "@/config/env";

// El testigo de un restablecimiento (RF-712; TRD §9.2, fila «Invitaciones»). Restablecerle
// el segundo factor a alguien son dos envíos: confirmar, y restablecer. El segundo no tiene
// tope de repetición en la base: cada vez revoca la invitación anterior, cambia el código
// dictado y vuelve a cerrar sesiones. Sin JavaScript, recargar la página reenvía el último
// formulario, y el código que ya se dictó moriría sin aviso.
//
// Por eso el primer envío deja este testigo, y el segundo lo exige y lo gasta antes de
// llamar a la base: un reenvío ya no lo encuentra. Va atado a la sesión y a la persona que
// se va a restablecer, y lleva una marca al azar que nace con cada primer envío: el valor
// es `sesión.persona.marca`. La marca viaja también en el botón de confirmar, así que un
// formulario de una confirmación anterior no vale para el testigo de la siguiente: volver
// atrás y reenviarlo después de haber pedido otra confirmación no restablece.
//
// No es un control de acceso, ni un candado: quién puede restablecer lo decide la base, y
// dos envíos que salgan a la vez (un doble clic sin JavaScript) lo leen los dos. La marca
// no es un secreto: solo distingue una confirmación de otra. No va firmado: quien pudiera
// escribir cookies en ese navegador solo lograría que un restablecimiento que la persona de
// todos modos confirmó no se tome por repetido.

/** Lo que dura: lo que tarda alguien en leer qué va a pasar y confirmarlo. */
export const RESET_TOKEN_MAX_AGE_SECONDS = 600;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARK = "[A-Za-z0-9_-]{22}";
const VALUE = new RegExp(`^(${ID})\\.(${ID})\\.(${MARK})$`);
const ONE = new RegExp(`^${ID}$`);

export function createResetTokens(overrides: { secure?: () => boolean; mark?: () => string } = {}) {
  const secure = overrides.secure ?? (() => isSecureSite(getEnv().NEXT_PUBLIC_SITE_URL));
  const mark = overrides.mark ?? (() => randomBytes(16).toString("base64url"));
  // Con https, el prefijo impide que otro subdominio la plante. En local un navegador lo
  // rechazaría: es la misma regla de la cookie de sesión.
  const name = () => (secure() ? "__Host-plataforma-restablecer" : "plataforma-restablecer");
  const options = (maxAge: number) => ({ httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge }) as const;

  /**
   * Deja el testigo de restablecer a esa persona con esa sesión, y devuelve su marca, que es
   * lo que el botón de confirmar tiene que traer. Nulo si no se dejó: lo que no tiene forma
   * no se deja.
   */
  function keepResetToken(jar: CookieJar, sessionId: string, profileId: string): string | null {
    if (!ONE.test(sessionId) || !ONE.test(profileId)) return null;
    const fresh = mark();
    jar.set(name(), `${sessionId}.${profileId}.${fresh}`, options(RESET_TOKEN_MAX_AGE_SECONDS));
    return fresh;
  }

  /** Si ese navegador trae el testigo de esa sesión, para esa persona y con esa marca. No lo gasta. */
  function holdsResetToken(reader: CookieReader, sessionId: string, profileId: string, presented: unknown): boolean {
    const match = VALUE.exec(reader.get(name()) ?? "");
    return match !== null && match[1] === sessionId && match[2] === profileId && match[3] === presented;
  }

  /**
   * Lo gasta: verdadero si era ese, y entonces ya no está. El de otra persona, de otra
   * sesión o de otra confirmación se queda como está: no es el de este envío.
   */
  function spendResetToken(jar: CookieJar, sessionId: string, profileId: string, presented: unknown): boolean {
    if (!holdsResetToken(jar, sessionId, profileId, presented)) return false;
    jar.set(name(), "", options(0));
    return true;
  }

  return { keepResetToken, holdsResetToken, spendResetToken };
}

export const { keepResetToken, holdsResetToken, spendResetToken } = createResetTokens();
