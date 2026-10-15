// Quién tiene acceso hoy (RN-01, RF-203; TRD §5.1). La única regla que lo responde: el
// acceso se calcula cada vez y no se guarda. T-202 la pregunta desde la función única de
// medios; cualquier pantalla que necesite saberlo le pregunta a ella.
//
// Una cuenta tiene acceso si cumple una de estas (RN-01), y nunca si está suspendida:
//   1. un periodo pagado que todavía no termina, aunque haya cancelado;
//   2. su última renovación falló hace no más de `GRACIA_COBRO_DIAS`. Es una RENOVACIÓN: hace
//      falta un periodo pagado antes, y la falla ya ocurrió. Una falla sin pago previo, o con
//      fecha futura, no da gracia;
//   3. una cortesía vigente (RF-213).
//
// Los bordes. Todo intervalo es semiabierto, [inicio, fin). «Hace no más de
// GRACIA_COBRO_DIAS» se lee así, con días de 24 horas exactas: los instantes van en UTC, y los
// reintentos de cobro se configuran dentro de la gracia (TRD §8.1). `until` es el fin de la
// base con que hoy tiene acceso, no forzosamente el primer instante sin acceso: después de una
// suscripción puede venir una gracia, y después de una cortesía, otra.
//
// Cuando aplican varias, el orden es suscripción, gracia, cortesía (decisión de Sergio del
// 2026-10-15): solo las dos primeras generan puntos para el reparto (RN-08), y quien paga y
// además tiene cortesía cuenta como quien paga.
//
// De dónde sale cada hecho lo decide quien los reúne (T-202), y aquí se dice para que no se
// invente dos veces. `paidThrough`, `lastRenewalFailedAt`, `endedAt` y `refunded` salen los
// cuatro de LA MISMA suscripción, la más reciente: el fin de una suscripción vieja no corta
// una nueva.
//   · `paidThrough` es el fin de su último periodo PAGADO, también si después se reembolsó
//     (lo corta `endedAt`). No es el fin de periodo del proveedor de cobro, que avanza aunque
//     el cobro falle: copiarlo haría que nunca se entrara en gracia (se confirma en T-303).
//   · `lastRenewalFailedAt` es su falla; nula si la última renovación no falló. Un reintento
//     que vuelve a fallar no la mueve (FL-21 E2).
//   · `endedAt` es su `ended_at`: cancelar durante la gracia (RF-204) o un reembolso (RF-210)
//     cortan ahí. Cancelar con el periodo vigente no lo pone: termina sola al fin del periodo.
//     Un reembolso por cobro duplicado tampoco. No corta una cortesía.
//   · `refunded` solo cambia el motivo, y solo si el reembolso fue lo que cortó.
//   · `graceDays` es el valor del parámetro vigente A LA HORA DE LA FALLA: un cambio de
//     parámetro no toca lo ya ocurrido, y subir la gracia no revive un acceso terminado.
//   · `suspended` es cualquier estado de la cuenta que no sea activo (también una borrada).
//   · `courtesy` son las cortesías sin revocar, con su inicio y su fin (nulo: sin fin).
//
// El correo verificado no entra aquí: RN-01 no lo pide. Es del curso abierto (RF-309), y
// entra en T-202 con quien mira.
//
// Lo que no tiene sentido (una fecha inválida, días de gracia que no son un entero de 0 en
// adelante, o una gracia que se sale de las fechas) contesta `invalid_input`: «no se supo».
// Nunca se trata como «sin acceso», que le pediría pagar a quien quizá ya pagó.

export interface CourtesyWindow {
  from: Date;
  /** Nulo: sin fin. */
  until: Date | null;
}

/** Los hechos de una cuenta que decide la regla. Los reúne el servicio; aquí no hay base. */
// Los cuatro de la suscripción salen de la misma, la más reciente (arriba).
export interface AccountFacts {
  suspended: boolean;
  paidThrough: Date | null;
  lastRenewalFailedAt: Date | null;
  endedAt: Date | null;
  /** Solo elige el motivo: lo que corta el acceso es `endedAt`. */
  refunded: boolean;
  courtesy: ReadonlyArray<CourtesyWindow>;
}

export type AccessBasis = "subscription" | "grace" | "courtesy";

/** Los motivos de rechazo, en una lista cerrada: una pantalla nueva no compila sin su caso. */
export const ACCOUNT_DENIALS = ["suspended", "never_subscribed", "expired", "grace_ended", "refunded", "invalid_input"] as const;

export type AccountAccess =
  /** `until`: el fin de esta base (nulo: una cortesía sin fin). Puede seguir otra base. */
  | { allowed: true; basis: AccessBasis; until: Date | null }
  /** Con la fecha en que terminó: PA-33 dice «Tu acceso terminó el {fecha}». */
  | { allowed: false; reason: "expired" | "grace_ended" | "refunded"; endedAt: Date }
  | { allowed: false; reason: "suspended" | "never_subscribed" }
  /** «No se supo»: quien pregunta lo trata como una falla, nunca como «sin acceso». */
  | { allowed: false; reason: "invalid_input" };

const DAY_MS = 24 * 60 * 60 * 1000;
/** El mayor instante que un `Date` admite. */
const MAX_TIME = 8.64e15;

const isValid = (date: Date | null) => date === null || !Number.isNaN(date.getTime());
/** El menor de dos fines, donde nulo es «sin corte». */
const cut = (end: number, by: Date | null) => (by === null ? end : Math.min(end, by.getTime()));

export function resolveAccountAccess(facts: AccountFacts, now: Date, params: { graceDays: number }): AccountAccess {
  const { graceDays } = params;
  if (
    Number.isNaN(now.getTime()) ||
    !isValid(facts.paidThrough) ||
    !isValid(facts.lastRenewalFailedAt) ||
    !isValid(facts.endedAt) ||
    facts.courtesy.some((window) => !isValid(window.from) || !isValid(window.until)) ||
    !Number.isSafeInteger(graceDays) ||
    graceDays < 0
  ) {
    return { allowed: false, reason: "invalid_input" };
  }
  const failedAt = facts.lastRenewalFailedAt;
  const graceStop = failedAt === null ? null : failedAt.getTime() + graceDays * DAY_MS;
  if (graceStop !== null && graceStop > MAX_TIME) return { allowed: false, reason: "invalid_input" };

  if (facts.suspended) return { allowed: false, reason: "suspended" };

  const time = now.getTime();
  const subscriptionEnd = facts.paidThrough === null ? null : cut(facts.paidThrough.getTime(), facts.endedAt);
  // La gracia es de una renovación: con un periodo pagado antes, y desde la falla. Una que no
  // empezó tampoco cuenta para el motivo.
  const graceStarted = facts.paidThrough !== null && failedAt !== null && failedAt.getTime() <= time;
  const graceEnd = graceStarted && graceStop !== null ? cut(graceStop, facts.endedAt) : null;

  if (subscriptionEnd !== null && time < subscriptionEnd) {
    return { allowed: true, basis: "subscription", until: new Date(subscriptionEnd) };
  }
  if (graceEnd !== null && time < graceEnd) {
    return { allowed: true, basis: "grace", until: new Date(graceEnd) };
  }

  // Las que la cubren ahora: hasta el fin más lejano, y sin fin si alguna no tiene. Un ciclo y
  // no `Math.max(...)`: con muchas, esparcirlas desborda la pila.
  let covered = false;
  let courtesyEnd: number | null = Number.NEGATIVE_INFINITY;
  for (const window of facts.courtesy) {
    if (window.from.getTime() > time || (window.until !== null && time >= window.until.getTime())) continue;
    covered = true;
    courtesyEnd = window.until === null || courtesyEnd === null ? null : Math.max(courtesyEnd, window.until.getTime());
  }
  if (covered) return { allowed: true, basis: "courtesy", until: courtesyEnd === null ? null : new Date(courtesyEnd) };

  // Sin acceso. El motivo es lo último que terminó: una falla vieja ya recuperada no dice
  // «no pudimos cobrar». Si la gracia y el periodo terminan a la vez, manda la gracia. Se dice
  // «reembolsada» solo si fue el reembolso lo que cortó.
  const ended = (reason: "expired" | "grace_ended", at: number): AccountAccess =>
    facts.refunded && facts.endedAt !== null && facts.endedAt.getTime() === at
      ? { allowed: false, reason: "refunded", endedAt: new Date(at) }
      : { allowed: false, reason, endedAt: new Date(at) };
  if (graceEnd !== null && (subscriptionEnd === null || graceEnd >= subscriptionEnd)) return ended("grace_ended", graceEnd);
  if (subscriptionEnd !== null) return ended("expired", subscriptionEnd);
  // Nunca pagó: lo mismo que quien nunca se suscribió, aunque haya tenido cortesía (decisión
  // de Sergio del 2026-10-15) o le haya fallado un primer cobro.
  return { allowed: false, reason: "never_subscribed" };
}
