import "server-only";

import type * as adapter from "@/adapters/supabase/auth";
import type { CookieJar, CookieOptions } from "@/adapters/supabase/auth-cookies";
import type { FailureCode } from "@/services/error-reporting/server";

import type { Timing } from "./timing";

// Lo que los servicios de cuenta reciben de fuera, para poder probarlos: el adaptador de
// Auth, de dónde se cree la dirección, el reloj del piso de tiempo, a quién se le reporta y
// cómo se manda trabajo detrás de la respuesta.

/** Lo que estos servicios usan del adaptador de Auth. */
export type AuthPort = Pick<
  typeof adapter,
  | "signIn"
  | "signOut"
  | "readSession"
  | "requestSignUp"
  | "requestPasswordRecovery"
  | "redeemSignupLink"
  | "redeemRecoveryLink"
  | "setFirstPassword"
  | "setRecoveredPassword"
  | "closeAllSessions"
  | "discardRedemption"
>;

export interface AccountDependencies {
  auth: AuthPort;
  /** Hay delante un alojamiento que pone la cabecera de la dirección y pisa la de quien pide. */
  proxyTrusted: () => boolean;
  /**
   * Corre en local. Ahí un borrador (versión 0) vale como texto legal vigente, y no saber
   * de qué dirección viene una petición es lo normal: nadie pone la cabecera.
   */
  isLocal: () => boolean;
  /** El reloj y la espera del piso de tiempo de respuesta. */
  timing: Timing | undefined;
  report: (code: FailureCode) => Promise<void>;
  /**
   * Corre un trabajo detrás de la respuesta: pedirle a Auth el correo de registro o de
   * recuperación, que tarda distinto según exista la cuenta. Sin nada que lo mande detrás,
   * corre en línea; quien tiene la petición le pasa lo que su plataforma dé para eso.
   */
  defer: (work: () => Promise<void>) => Promise<void>;
}

export interface StagingJar extends CookieJar {
  readonly writes: { name: string; value: string; options: CookieOptions }[];
}

/** Un tarro que solo recuerda lo que se le escribe: la cookie no llega al navegador. */
export function stagingJar(): StagingJar {
  const values = new Map<string, string>();
  const writes: StagingJar["writes"] = [];
  return {
    writes,
    get: (name) => values.get(name),
    set(name, value, options) {
      writes.push({ name, value, options });
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}
