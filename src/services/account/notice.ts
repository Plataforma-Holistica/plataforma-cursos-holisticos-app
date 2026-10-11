import "server-only";

import { isSecureSite, type CookieJar, type CookieReader } from "@/adapters/supabase/auth-cookies";
import { getEnv } from "@/config/env";

// El aviso que una pantalla le deja a la siguiente: «tu contraseña se cambió», «tu cuenta
// está lista» (diseño, PA-11). Viaja en una cookie corta y no en la dirección de la página:
// en la dirección, cualquier enlace armado por otro haría que la pantalla de entrar dijera
// «tu contraseña se cambió».
//
// La cookie lleva una clave de una lista cerrada, nunca un texto. El texto lo pone la
// pantalla, del catálogo. Lo que no sea una clave de la lista no dice nada.

export const NOTICES = ["password_changed", "account_ready", "choose_password"] as const;
export type Notice = (typeof NOTICES)[number];

/** Lo que dura: lo justo para llegar a la pantalla siguiente y leerla. */
export const NOTICE_MAX_AGE_SECONDS = 60;

const known: ReadonlySet<string> = new Set(NOTICES);

export function createNotices(overrides: { secure?: () => boolean } = {}) {
  const secure = overrides.secure ?? (() => isSecureSite(getEnv().NEXT_PUBLIC_SITE_URL));
  // Con https, el prefijo impide que otro subdominio la plante. En local un navegador lo
  // rechazaría: es la misma regla de la cookie de sesión.
  const name = () => (secure() ? "__Host-plataforma-aviso" : "plataforma-aviso");
  const options = (maxAge: number) => ({ httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge }) as const;

  /** Deja el aviso para la pantalla siguiente. Solo desde una acción o una ruta. */
  function leaveNotice(jar: CookieJar, notice: Notice): void {
    jar.set(name(), notice, options(NOTICE_MAX_AGE_SECONDS));
  }

  /** El aviso pendiente, o nulo. Una página lo lee, pero no puede borrarlo: caduca solo. */
  function readNotice(reader: CookieReader): Notice | null {
    const value = reader.get(name());
    return value !== undefined && known.has(value) ? (value as Notice) : null;
  }

  /** Lo borra antes de que caduque. Lo llama la acción de la pantalla que ya lo mostró. */
  function clearNotice(jar: CookieJar): void {
    if (jar.get(name()) !== undefined) jar.set(name(), "", options(0));
  }

  return { leaveNotice, readNotice, clearNotice };
}

export const { leaveNotice, readNotice, clearNotice } = createNotices();
