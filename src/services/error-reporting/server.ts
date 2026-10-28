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
  team_unavailable: "No se pudo leer en qué estado está una cuenta respecto al equipo de administración, o su sesión no quedó de equipo después de dar bien su código: esa persona no pudo entrar a administración. Si le pasa a todo el equipo, falta el parámetro VIGENCIA_SEGUNDO_FACTOR_HORAS.",
  invitation_not_accepted: "Una invitación de administración no se pudo aceptar después de verificar el segundo factor: esa persona tiene que intentarlo de nuevo. Si se repite, falta un parámetro del segundo factor o la base no contesta.",
  invitation_answer_lost: "Una invitación de administración quedó aceptada, pero la respuesta de la base se perdió o no se entendió: a la persona se le dijo que sí. Si se repite, la base está contestando algo que el servidor no conoce.",
  second_factor_not_removed: "Un segundo factor recién verificado se quedó en una cuenta que no pudo aceptar su invitación: no le da acceso a nada, pero esa cuenta ya no cambia su contraseña desde la pantalla de la cuenta.",
  team_roster_unavailable: "No se pudo leer la lista del equipo de administración, o llegó sin la fila de quien la pidió: esa persona no pudo ver ni cambiar al equipo.",
  team_change_unavailable: "Un cambio al equipo de administración se quedó sin respuesta, o con una que el servidor no conoce: no se sabe si se hizo, y a quien lo pidió se le dijo que revise la lista. También sale cuando alguien dio bien su código y aun así ningún cambio pasaría: entonces falta el parámetro VIGENCIA_CODIGO_RECIENTE_MINUTOS, y solo lo arregla el dueño de la base.",
  catalog_lists_unavailable: "No se pudieron leer las prácticas y los niveles del catálogo: quien tiene Contenido no pudo verlas ni cambiarlas.",
  media_grant_unavailable: "No se pudo firmar la dirección de un video para alguien que podía verlo: falta la llave de firma de Mux, la llave no sirve, o falta un dato (la duración de la lección, VELOCIDAD_MIN o VELOCIDAD_MAX, o unas velocidades que no dejan un menú). Quien lo pidió no pudo reproducirlo.",
  lesson_page_unavailable: "No se pudo leer el temario de una lección para pintar su página. Quien la pidió vio «algo falló» (PA-18).",
  captions_choice_unavailable: "No se pudo leer o guardar si una cuenta deja encendidos los subtítulos: el reproductor arrancó con ellos apagados, o la elección no se recordó para la siguiente lección.",
  media_watermark_unavailable: "Una cuenta con acceso pidió un video y su correo no sirve para la marca de agua (falta, está vacío o no tiene forma de correo). Sin marca no se da el video: quien lo pidió no pudo reproducirlo.",
  media_facts_unavailable: "No se pudieron leer, o no tenían sentido, los hechos con que se decide si una cuenta ve un video (su suscripción, sus cortesías, la lección, o GRACIA_COBRO_DIAS a la hora de una falla de cobro); o la regla dejó ver una lección cuyo video la base no soltó. A quien lo pidió se le dijo «no se pudo», nunca que pague.",
  playback_unavailable: "No se pudo abrir o latir una reproducción (T-204): la base no contestó, faltan SESIONES_SIMULTANEAS o LATIDO_SEGUNDOS, la base no reconoció la sesión que pasó la guarda, o el video de la lección cambió entre decidir y abrir. Al abrir, a quien lo pidió se le dijo «no se pudo»; al latir, el video siguió y el siguiente latido lo vuelve a intentar.",
  heartbeat_unavailable:
    "No se registraron los tramos vistos de una reproducción (T-205): la base no contestó o contestó `failed` (falta la partición del mes, VELOCIDAD_MAX o ZONA_HORARIA_PERIODO), o no se supo si el acceso de la cuenta cuenta a esa hora. No se registró nada: los tramos se quedan en la cola del navegador y se mandan otra vez.",
  progress_unavailable:
    "No se pudo fundir en el progreso lo visto de una reproducción (T-206): falta UMBRAL_COMPLETO_PCT o no es un entero de 1 a 10 000, o la base falló en el progreso. Los tramos sí quedaron en el libro: el progreso de esa lección se rehace desde ahí, y mientras tanto puede decir «a medias» una lección terminada.",
  continue_watching_unavailable: "No se pudo leer «continuar viendo» de una cuenta (T-206): su inicio se pintó sin esa lista.",
  media_email_unverified: "Una cuenta que pasó la guarda pidió un video sin tener su correo verificado. No debería pasar: el registro verifica el correo. La regla siguió sin abrirle el curso abierto.",
  review_queue_unavailable: "No se pudo leer la cola de revisión: quien tiene Contenido no pudo ver los cursos por aprobar.",
  course_approval_unavailable: "Aprobar un curso se quedó sin respuesta, o con una que el servidor no conoce: no se sabe si quedó publicado, y a quien lo pidió se le dijo que revise la cola.",
  catalog_change_unavailable: "Un cambio a las prácticas o los niveles del catálogo se quedó sin respuesta, o con una que el servidor no conoce: no se sabe si se hizo, y a quien lo pidió se le dijo que revise la lista.",
  anomaly_alerts_unavailable: "No se pudieron leer las alertas de anomalía: quien tiene finanzas no pudo verlas ni decidir sobre ellas (PA-68).",
  anomaly_decision_unavailable: "Una decisión de finanzas sobre una alerta de anomalía (revisarla, decidir fraude, excluir o revertir consumo) se quedó sin respuesta, o con una que el servidor no conoce: no se sabe si se hizo, y a quien la pidió se le dijo que revise la alerta. También sale cuando alguien dio bien su código y aun así ninguna decisión pasaría: entonces falta el parámetro VIGENCIA_CODIGO_RECIENTE_MINUTOS.",
  periods_unavailable: "No se pudieron leer los periodos, el panel de uno o su ensayo y cierre: quien tiene finanzas no pudo verlos (PA-78 a PA-80).",
  period_change_unavailable:
    "Una decisión de finanzas sobre un periodo (pedir el recálculo, ensayar, cerrar o descargar la exportación) se quedó sin respuesta, o con una que el servidor no conoce: no se sabe si se hizo, y la pantalla vuelve a leer el periodo. También sale cuando alguien dio bien su código y aun así ninguna decisión pasaría: entonces falta el parámetro VIGENCIA_CODIGO_RECIENTE_MINUTOS.",
  close_timed_out:
    "Un ensayo o un cierre pasó del tope de tiempo de la base (statement_timeout, 57014): no se guardó nada y se le pidió a finanzas intentar de nuevo. Si se repite, el cierre ya no cabe en una transacción del servidor (05 §14.4): medirlo con scale_test.",
  close_unbalanced:
    "Al confirmar un cierre, la comprobación diferida rechazó la suma (23514: el reparto no es igual al bote, o la exportación no es la que regenera la base). No se cerró nada. Es un defecto del cálculo: revisar check_period_balanced y el registro de la base.",
  legal_text_unavailable:"No se pudo leer un texto legal de la base: quien lo abrió no pudo leerlo.",
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
