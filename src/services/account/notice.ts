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

export const NOTICES = [
  "password_changed",
  "password_unconfirmed",
  "account_ready",
  "choose_password",
  // El segundo factor quedó configurado y la invitación, aceptada: entra de nuevo.
  "second_factor_ready",
  // El freno de los códigos rechazó, y Auth cerró todas las sesiones de la cuenta.
  "second_factor_throttled",
  // La sesión se cerró en otro lado a media operación.
  "session_ended",
  // Alguien del equipo se quitó una capacidad a sí misma: la base cerró todas sus sesiones.
  "capability_removed",
  // Un curso quedó aprobado y publicado (T-108): la cola lo dice al volver a pintarse.
  "course_approved",
  // Las decisiones de finanzas sobre una alerta (T-208): las alertas lo dicen al volver a pintarse.
  "alert_reviewed",
  "fraud_decided",
  "account_excluded",
  "exclusion_revoked",
  // Las decisiones de finanzas sobre un periodo (T-605): el panel y el cierre lo dicen al volver a pintarse.
  "rollup_requested",
  "period_rehearsed",
  "period_closed",
  // Las liquidaciones del periodo (PA-81, T-605): liberar, y cualquier otra decisión sobre una fila.
  "payouts_released",
  "payouts_updated",
  // Una versión de un texto legal quedó publicada (PA-89, T-110).
  "legal_published",
] as const;
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
