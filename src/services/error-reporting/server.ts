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
  session_not_tagged: "Una sesión se abrió sin que quedara dicho desde qué navegador: su dueña la verá como de un navegador desconocido.",
  session_cookie_not_written: "Una entrada no pudo escribir su cookie: se llamó desde donde no se pueden escribir.",
  sign_in_settle_failed: "Una entrada no se pudo cerrar en el freno: su intento quedó contado como fallo.",
  client_ip_unknown: "Fuera de local no se supo de qué dirección viene una petición: todas comparten un tope.",
  mail_limits_unavailable: "Los topes de correo no pudieron leer sus parámetros o sus cuentas: nadie puede pedir registro ni recuperación.",
  registration_mail_failed: "El servidor de identidad no mandó un correo de registro que se le pidió.",
  recovery_mail_failed: "El servidor de identidad no mandó un correo de recuperación que se le pidió.",
  mail_not_deferred: "Pedir un correo no se pudo mandar detrás de la respuesta y corrió dentro de ella: lo que tarda puede delatar si ese correo tiene cuenta.",
  registration_incomplete: "Un registro se quedó a medias después de gastar su enlace: esa persona tiene que recuperar su contraseña.",
  recovery_incomplete: "Una recuperación se quedó a medias después de gastar su enlace: esa persona tiene que pedir otro.",
  recovery_notice_not_sent: "Una contraseña se recuperó por el camino de administración: el aviso de cambio de contraseña no salió.",
  recovery_with_second_factor: "Una cuenta con segundo factor recuperó su contraseña desde su correo: a esa cuenta no le sale el aviso de cambio de contraseña, y conviene confirmar que fue su dueña.",
  mailbox_proof_unavailable: "No se supo cuánto dura una prueba del buzón, porque falta el parámetro VIGENCIA_PRUEBA_BUZON_MINUTOS o no se pudo leer: esa cuenta se quedó sin resguardo. Si es el parámetro, nadie puede aceptar una invitación de administración hasta que se ponga.",
  mailbox_ticket_not_kept: "Una prueba del buzón no pudo dejar su cookie: si esa cuenta tiene una invitación de administración, tendrá que recuperar su contraseña otra vez para aceptarla.",
  legal_text_unavailable: "No se pudo leer un texto legal de la base: quien lo abrió no pudo leerlo.",
  account_unavailable: "No se pudo leer o guardar un dato de una cuenta con sesión: esa persona no pudo administrar su cuenta.",
  password_change_unconfirmed: "Un cambio de contraseña desde la cuenta se quedó sin respuesta del servidor de identidad: no se sabe cuál vale, y esa cuenta quedó sin sesiones.",
  password_change_incomplete: "Una contraseña se cambió desde la cuenta y la aplicación no pudo fechar el cambio: una entrada hecha antes con la contraseña vieja podría quedar reconocida.",
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
