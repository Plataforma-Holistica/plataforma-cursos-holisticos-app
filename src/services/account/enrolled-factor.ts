import "server-only";

import { isSecureSite, type CookieJar, type CookieReader } from "@/adapters/supabase/auth-cookies";
import { getEnv } from "@/config/env";

// El factor que el servidor dio de alta en este navegador (TRD §9.2, fila «Invitaciones»).
// Dar de alta un factor y verificar su código son dos peticiones: entre una y otra, cuál
// factor es viaja en una cookie del servidor, no en el formulario. Al aceptar una
// invitación, la base ata el factor que el servidor le diga, y el servidor dice este: si
// alguien con la sesión de la persona verificara por fuera un factor suyo, no es el que
// quedó anotado aquí.
//
// Va atado a la sesión: el valor es `sesión.factor`, y con otra sesión no se lee. No va
// firmado: quien pudiera escribir cookies en ese navegador tendría además que lograr que la
// persona verificara un factor ajeno.

/** Lo que dura: lo que tarda alguien en abrir su aplicación de códigos y teclear uno. */
export const ENROLLED_FACTOR_MAX_AGE_SECONDS = 900;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const VALUE = new RegExp(`^(${ID})\\.(${ID})$`);
const ONE = new RegExp(`^${ID}$`);

export function createEnrolledFactors(overrides: { secure?: () => boolean } = {}) {
  const secure = overrides.secure ?? (() => isSecureSite(getEnv().NEXT_PUBLIC_SITE_URL));
  // Con https, el prefijo impide que otro subdominio la plante. En local un navegador lo
  // rechazaría: es la misma regla de la cookie de sesión.
  const name = () => (secure() ? "__Host-plataforma-factor" : "plataforma-factor");
  const options = (maxAge: number) => ({ httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge }) as const;

  /** Anota el factor recién dado de alta con esa sesión. Lo que no tiene forma no se anota. */
  function keepEnrolledFactor(jar: CookieJar, sessionId: string, factorId: string): boolean {
    if (!ONE.test(sessionId) || !ONE.test(factorId)) return false;
    jar.set(name(), `${sessionId}.${factorId}`, options(ENROLLED_FACTOR_MAX_AGE_SECONDS));
    return true;
  }

  /** El factor anotado para esa sesión, o nulo: sin cookie, sin forma, o de otra sesión. */
  function readEnrolledFactor(reader: CookieReader, sessionId: string): string | null {
    const match = VALUE.exec(reader.get(name()) ?? "");
    return match && match[1] === sessionId ? (match[2] ?? null) : null;
  }

  /** Lo borra: ya se ató, ya no existe, o ya no corresponde. */
  function dropEnrolledFactor(jar: CookieJar): void {
    if (jar.get(name()) !== undefined) jar.set(name(), "", options(0));
  }

  return { keepEnrolledFactor, readEnrolledFactor, dropEnrolledFactor };
}

export const { keepEnrolledFactor, readEnrolledFactor, dropEnrolledFactor } = createEnrolledFactors();
