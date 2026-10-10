// Los topes por ventana (TRD §9.9).
//
// Las ventanas son fijas y alineadas al reloj, que es lo que guarda
// private.rate_limit_counters (una fila por clave y por inicio de ventana): la hora en
// punto para los topes por hora. Una ventana fija deja pasar hasta el doble justo en el
// cambio de ventana; para un tope contra el abuso es aceptable, y es lo que la tabla da.
//
// Las cuentas que entran aquí son las de ANTES del intento que se decide. Con el tope ya
// contado, el siguiente no pasa. Lo que se niega no se cuenta: si se contara, quien ya
// llegó al tope seguiría empujando la cuenta de otros.

export const HOUR_SECONDS = 3600;

const isCount = (value: number) => Number.isInteger(value) && value >= 0;
const isLimit = (value: number) => Number.isInteger(value) && value >= 1;

export type WindowStart =
  | { ok: true; /** El primer instante de la ventana que contiene al momento dado. */ start: Date }
  | { ok: false; reason: "invalid_clock" | "invalid_window" };

/** El inicio de la ventana fija, de `windowSeconds`, en la que cae `now`. En UTC. */
export function windowStart(now: Date, windowSeconds: number): WindowStart {
  const time = now.getTime();
  if (Number.isNaN(time)) return { ok: false, reason: "invalid_clock" };
  if (!isLimit(windowSeconds)) return { ok: false, reason: "invalid_window" };
  const size = windowSeconds * 1000;
  return { ok: true, start: new Date(Math.floor(time / size) * size) };
}

export type RegistrationDecision =
  | { proceed: true }
  // Este tope sí se le dice a la persona («espera un momento»): no delata nada de nadie.
  | { proceed: false; reason: "ip_hourly_cap" | "invalid_input" };

/** Si una dirección puede registrar otra cuenta en esta hora (`TOPE_REGISTROS_HORA`). */
export function decideRegistration(
  facts: { /** Registros ya contados a esta dirección en la hora. */ ipHitsThisHour: number },
  params: { hourlyCap: number },
): RegistrationDecision {
  if (!isCount(facts.ipHitsThisHour) || !isLimit(params.hourlyCap)) return { proceed: false, reason: "invalid_input" };
  if (facts.ipHitsThisHour >= params.hourlyCap) return { proceed: false, reason: "ip_hourly_cap" };
  return { proceed: true };
}

export type MailDecision =
  | { send: true }
  // Ninguno de los dos motivos se le dice a la persona: la respuesta es la de siempre y no
  // se manda nada (RF-101). El motivo es para el servicio y para las pruebas.
  | { send: false; reason: "mailbox_hourly_cap" | "resend_wait" | "invalid_input" };

/**
 * Si se le manda otro correo a un buzón: registro, reenvío y recuperación suman al mismo
 * tope (`TOPE_ENVIOS_CORREO_HORA`), y entre dos correos pasa la espera (`ESPERA_REENVIO`).
 * La espera se cuenta como una ventana propia, del tamaño de la espera, con tope de uno.
 */
export function decideMailSend(
  facts: {
    /** Correos ya contados a este buzón en la hora. */
    mailboxHitsThisHour: number;
    /** Correos ya contados a este buzón en la ventana de la espera. */
    mailboxHitsThisWait: number;
  },
  params: { hourlyCap: number },
): MailDecision {
  if (!isCount(facts.mailboxHitsThisHour) || !isCount(facts.mailboxHitsThisWait) || !isLimit(params.hourlyCap)) {
    return { send: false, reason: "invalid_input" };
  }
  // Primero el tope, que dura más: si coinciden, ese es el motivo.
  if (facts.mailboxHitsThisHour >= params.hourlyCap) return { send: false, reason: "mailbox_hourly_cap" };
  if (facts.mailboxHitsThisWait >= 1) return { send: false, reason: "resend_wait" };
  return { send: true };
}
