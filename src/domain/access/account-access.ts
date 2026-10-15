// Quién tiene acceso hoy (RN-01, RF-203; TRD §5.1). La única regla que lo responde: el
// acceso se calcula cada vez y no se guarda. T-202 la pregunta desde la función única de
// medios; cualquier pantalla que necesite saberlo le pregunta a ella.
//
// Una cuenta tiene acceso si cumple una de estas (RN-01), y nunca si está suspendida:
//   1. un periodo pagado que todavía no termina, aunque haya cancelado;
//   2. su última renovación falló hace no más de `GRACIA_COBRO_DIAS`;
//   3. una cortesía vigente (RF-213).
//
// Los bordes. Todo intervalo es semiabierto, [inicio, fin): `until` es el primer instante sin
// acceso. «Hace no más de GRACIA_COBRO_DIAS» se lee así, con días de 24 horas exactas: los
// instantes van en UTC, y los reintentos de cobro se configuran dentro de la gracia (TRD §8.1).
//
// Cuando aplican varias, el orden es suscripción, gracia, cortesía (decisión de Sergio del
// 2026-10-15): solo las dos primeras generan puntos para el reparto (RN-08), y quien paga y
// además tiene cortesía cuenta como quien paga.
//
// De dónde sale cada hecho lo decide quien los reúne (T-202), y aquí se dice para que no se
// invente dos veces:
//   · `paidThrough` es el fin del último periodo PAGADO, entre las suscripciones no
//     reembolsadas. No es el fin de periodo del proveedor de cobro, que avanza aunque el
//     cobro falle: copiarlo haría que nunca se entrara en gracia (se confirma en T-303).
//   · `lastRenewalFailedAt` es la falla de la suscripción viva; nula si la última renovación
//     no falló. Un reintento que vuelve a fallar no la mueve (FL-21 E2).
//   · `endedAt` es `subscriptions.ended_at`: cancelar durante la gracia (RF-204) o un
//     reembolso (RF-210) cortan ahí. Cancelar con el periodo vigente no lo pone: la
//     suscripción termina sola al fin del periodo. Un reembolso por cobro duplicado tampoco.
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
  /** `until` nulo: una cortesía sin fin. */
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
  const graceEnd = graceStop === null ? null : cut(graceStop, facts.endedAt);

  if (subscriptionEnd !== null && time < subscriptionEnd) {
    return { allowed: true, basis: "subscription", until: new Date(subscriptionEnd) };
  }
  if (graceEnd !== null && time < graceEnd) {
    return { allowed: true, basis: "grace", until: new Date(graceEnd) };
  }

  const ends = facts.courtesy
    .filter((window) => window.from.getTime() <= time && (window.until === null || time < window.until.getTime()))
    .map((window) => window.until);
  if (ends.length > 0) {
    // Hasta el fin más lejano de las que la cubren ahora; sin fin si alguna no tiene.
    const until = ends.every((end): end is Date => end !== null) ? new Date(Math.max(...ends.map((end) => end.getTime()))) : null;
    return { allowed: true, basis: "courtesy", until };
  }

  // Sin acceso. El motivo es lo último que terminó: una falla vieja ya recuperada no dice
  // «no pudimos cobrar». Si la gracia y el periodo terminan a la vez, manda la gracia.
  const ended = (reason: "expired" | "grace_ended", at: number): AccountAccess =>
    facts.refunded ? { allowed: false, reason: "refunded", endedAt: new Date(at) } : { allowed: false, reason, endedAt: new Date(at) };
  if (graceEnd !== null && (subscriptionEnd === null || graceEnd >= subscriptionEnd)) return ended("grace_ended", graceEnd);
  if (subscriptionEnd !== null) return ended("expired", subscriptionEnd);
  // Nunca pagó ni le falló un cobro: lo mismo que quien nunca se suscribió, aunque haya
  // tenido cortesía (decisión de Sergio del 2026-10-15).
  return { allowed: false, reason: "never_subscribed" };
}
