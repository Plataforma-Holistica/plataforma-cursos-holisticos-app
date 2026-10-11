import { captureServerFailure, startServerErrorReporting } from "@/adapters/sentry/server";
import { getEnv } from "@/config/env";

// El registro de errores visto desde el servidor (RNF-16). El arranque y las rutas piden
// aquí; qué proveedor lo atiende es asunto del adaptador.
//
// Solo para Node. Lo que Next llama al fallar una petición está en `request-error.ts`.

export const startErrorReporting = startServerErrorReporting;

// Los fallos de operación (TRD §9.2 y §10.5; RNF-16): algo que nadie lanzó, pero que una
// persona tiene que saber porque deja a gente sin poder entrar. Lista cerrada y mensajes
// fijos: lo que sale de aquí no puede traer el dato de nadie.
const FAILURES = {
  gate_no_current_text: "Falta el texto vigente de un documento legal obligatorio: nadie puede entrar.",
  gate_unavailable: "La guarda de sesión no pudo leer lo que necesita: quien lo intentó no pudo entrar.",
  throttle_unavailable: "El freno de intentos no pudo leer sus parámetros o sus cuentas: nadie puede entrar.",
  session_oversized: "Una sesión no cabe en su cookie: esa cuenta no entra hasta recuperar su contraseña.",
  session_not_noted: "El servidor de identidad abrió una sesión que la aplicación no pudo anotar.",
  session_not_closed: "Una sesión que ya no debía seguir no se pudo cerrar en el servidor de identidad.",
  sign_in_settle_failed: "Una entrada no se pudo cerrar en el freno: su intento quedó contado como fallo.",
  client_ip_unknown: "Fuera de local no se supo de qué dirección viene una petición: todas comparten un tope.",
} as const;

export type FailureCode = keyof typeof FAILURES;

export class OperationalFailure extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(FAILURES[code]);
    this.name = "OperationalFailure";
    this.code = code;
  }
}

/** Reporta un fallo de operación. Nunca lanza: reportar no puede tumbar lo que reporta. */
export async function reportFailure(code: FailureCode): Promise<void> {
  const failure = new OperationalFailure(code);
  console.error(`Fallo de operación (${code}): ${failure.message}`);
  try {
    await captureServerFailure(failure);
  } catch {
    // Ya quedó en los registros del servidor.
  }
}

/**
 * El simulacro: un error a propósito, para comprobar que el registro lo recibe y que la
 * alerta le llega a una persona. Nunca en producción.
 */
export function errorDrillAllowed(): boolean {
  const env = getEnv();
  // Dos condiciones, de dos fuentes: lo que se escribió en el panel y lo que Vercel dice
  // del despliegue. Un APP_ENV mal puesto no basta para que exista en producción.
  return env.APP_ENV !== "production" && env.VERCEL_ENV !== "production";
}

export class ErrorDrill extends Error {
  constructor() {
    super("Simulacro del registro de errores: este error se provocó a propósito.");
    this.name = "ErrorDrill";
  }
}
