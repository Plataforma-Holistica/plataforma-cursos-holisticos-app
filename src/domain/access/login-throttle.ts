// El freno progresivo del inicio de sesión (RF-102; TRD §9.2, fila «Freno progresivo», y §9.9).
//
// Tres cosas distintas, que se deciden juntas en una sola función para que su orden no
// quede repartido entre quien la llame:
//
//   - El freno vive en el PAR de cuenta y dirección: desde el fallo número
//     INTENTOS_ANTES_DE_FRENO cada fallo seguido exige una espera, que empieza en
//     FRENO_ESPERA_BASE y se duplica hasta FRENO_ESPERA_TOPE. Como es del par, nadie deja
//     fuera a otra persona fallando a propósito desde su propia red.
//   - El tope por hora de la DIRECCIÓN, sume a la cuenta que sume.
//   - El tope por hora de la CUENTA, sumando todas las direcciones. No frena al par que
//     entró bien hace menos de FRENO_CONFIANZA_DIAS: el dispositivo de siempre.
//
// El intento se cuenta ANTES de preguntarle a Auth, como si fuera a fallar, y se cierra
// después con lo que pasó. Si se contara después, cien peticiones a la vez leerían «todavía
// no está frenado» y pasarían las cien.
//
// Un intento que no procede no se evalúa ni se cuenta. No se le pregunta a Auth, así que no
// se sabe si era un fallo; y contarlo dejaría que cualquiera alargara la espera sin límite,
// o que una dirección ya topada siguiera empujando el tope de una cuenta.
//
// Aquí no hay base ni reloj: el servicio lee el par y las cuentas en una transacción corta
// que asegura la fila y la bloquea, llama a `decideSignInAttempt`, escribe lo que devuelve
// y suelta el candado antes de hablar con Auth. `now` es la hora de la base, no la del
// servidor de la aplicación.

/** Los parámetros de 00-fundamentos §4, ya en segundos y en días. */
export interface ThrottleParams {
  /** `INTENTOS_ANTES_DE_FRENO`: el fallo con este número es el primero que espera. */
  threshold: number;
  /** `FRENO_ESPERA_BASE`. */
  baseWaitSeconds: number;
  /** `FRENO_ESPERA_TOPE`. */
  maxWaitSeconds: number;
  /** `FRENO_OLVIDO`: tanto tiempo sin fallos y la cuenta de fallos vuelve a cero. */
  forgetAfterSeconds: number;
  /** `FRENO_CONFIANZA_DIAS`. */
  trustDays: number;
  /** `TOPE_INTENTOS_HORA`, por dirección y por cuenta. */
  hourlyCap: number;
}

/** Una fila de private.login_throttles. */
export interface PairState {
  failedCount: number;
  lockedUntil: Date | null;
  lastFailedAt: Date | null;
  lastSuccessAt: Date | null;
}

export interface SignInFacts {
  /** El par de esta cuenta y esta dirección, o nulo si nunca se vio. */
  pair: PairState | null;
  /** Fallos ya contados a esta dirección en la hora, contra cualquier cuenta. */
  ipHitsThisHour: number;
  /** Fallos ya contados a esta cuenta en la hora, desde cualquier dirección. */
  accountHitsThisHour: number;
}

export type SignInDecision =
  | {
      proceed: true;
      /**
       * El par con este intento ya contado como fallo. Se escribe antes de preguntarle a
       * Auth, junto con sumar uno a la cuenta de la dirección y a la de la cuenta.
       */
      pair: PairState;
    }
  // Frenado: la pantalla dice a qué hora se puede volver a intentar (PA-11).
  | { proceed: false; reason: "throttled"; retryAt: Date }
  // Topado: la pantalla pide volver más tarde, sin prometer una hora.
  | { proceed: false; reason: "ip_hourly_cap" | "account_hourly_cap" }
  // Parámetros, cuentas o fechas que no tienen sentido: no se deja pasar a nadie. Un freno
  // que con un dato malo se abre no es un freno.
  | { proceed: false; reason: "invalid_input" };

const DAY_SECONDS = 86_400;
const BLANK: PairState = { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: null };

const isCount = (value: number) => Number.isInteger(value) && value >= 0;
const isLimit = (value: number) => Number.isInteger(value) && value >= 1;
const isValidDate = (date: Date | null) => date === null || !Number.isNaN(date.getTime());

function validParams(params: ThrottleParams): boolean {
  return (
    isLimit(params.threshold) &&
    isLimit(params.baseWaitSeconds) &&
    isLimit(params.maxWaitSeconds) &&
    params.maxWaitSeconds >= params.baseWaitSeconds &&
    isLimit(params.forgetAfterSeconds) &&
    isLimit(params.trustDays) &&
    isLimit(params.hourlyCap)
  );
}

function validPair(pair: PairState): boolean {
  return (
    isCount(pair.failedCount) && isValidDate(pair.lockedUntil) && isValidDate(pair.lastFailedAt) && isValidDate(pair.lastSuccessAt)
  );
}

/** La espera que exige el fallo número `failedCount`, en segundos. */
function waitSeconds(failedCount: number, params: ThrottleParams): number {
  if (failedCount < params.threshold) return 0;
  // Paso a paso y cortando en el tope: con una potencia, un número grande de fallos se
  // desbordaría, y un desborde aquí abre el freno en vez de cerrarlo.
  let wait = params.baseWaitSeconds;
  for (let count = params.threshold; count < failedCount && wait < params.maxWaitSeconds; count += 1) wait *= 2;
  return Math.min(wait, params.maxWaitSeconds);
}

/** Entró bien desde esta misma dirección hace menos del plazo. Una fecha futura no cuenta. */
function isTrusted(pair: PairState, now: Date, params: ThrottleParams): boolean {
  if (pair.lastSuccessAt === null) return false;
  const elapsed = now.getTime() - pair.lastSuccessAt.getTime();
  return elapsed >= 0 && elapsed < params.trustDays * DAY_SECONDS * 1000;
}

export function decideSignInAttempt(facts: SignInFacts, now: Date, params: ThrottleParams): SignInDecision {
  const pair = facts.pair ?? BLANK;
  if (
    Number.isNaN(now.getTime()) ||
    !validParams(params) ||
    !validPair(pair) ||
    !isCount(facts.ipHitsThisHour) ||
    !isCount(facts.accountHitsThisHour)
  ) {
    return { proceed: false, reason: "invalid_input" };
  }

  // Los topes ganan al freno: si coinciden, el mensaje no puede prometer una hora que el
  // tope no va a cumplir.
  if (facts.ipHitsThisHour >= params.hourlyCap) return { proceed: false, reason: "ip_hourly_cap" };
  if (facts.accountHitsThisHour >= params.hourlyCap && !isTrusted(pair, now, params)) {
    return { proceed: false, reason: "account_hourly_cap" };
  }

  // Una espera ya puesta se respeta entera, también si el olvido se cumple antes.
  if (pair.lockedUntil !== null && now.getTime() < pair.lockedUntil.getTime()) {
    return { proceed: false, reason: "throttled", retryAt: pair.lockedUntil };
  }

  const forgotten =
    pair.lastFailedAt !== null && now.getTime() - pair.lastFailedAt.getTime() >= params.forgetAfterSeconds * 1000;
  const failedCount = (forgotten ? 0 : pair.failedCount) + 1;
  const wait = waitSeconds(failedCount, params);
  return {
    proceed: true,
    pair: {
      failedCount,
      lockedUntil: wait === 0 ? null : new Date(now.getTime() + wait * 1000),
      lastFailedAt: now,
      lastSuccessAt: pair.lastSuccessAt,
    },
  };
}

/**
 * Lo que pasó con el intento:
 *   - `success`: Auth aceptó Y la guarda de sesión dejó entrar. Una contraseña correcta en
 *     una cuenta que la guarda no deja entrar (la marca prendida) se cierra como `failure`:
 *     si no, quien dio de alta un correo ajeno quedaría como par de confianza.
 *   - `failure`: Auth rechazó.
 *   - `unknown`: no se supo (Auth no contestó). No se castiga a nadie por eso.
 */
export type SignInOutcome = "success" | "failure" | "unknown";

export interface SignInSettlement {
  /** El par como debe quedar escrito. */
  pair: PairState;
  /**
   * Restar el uno que se sumó por adelantado a la cuenta de la dirección y a la de la
   * cuenta, en la misma ventana en que se sumó: los topes son de fallos.
   */
  uncount: boolean;
}

/**
 * Cierra un intento que procedió.
 *
 * @param decision Lo que devolvió `decideSignInAttempt`.
 * @param before El par como estaba antes de esa decisión.
 */
export function settleSignIn(
  decision: Extract<SignInDecision, { proceed: true }>,
  before: PairState | null,
  outcome: SignInOutcome,
  now: Date,
): SignInSettlement {
  if (outcome === "failure") return { pair: decision.pair, uncount: false };
  if (outcome === "success") {
    return { pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: now }, uncount: true };
  }
  return { pair: before ?? BLANK, uncount: true };
}

/**
 * El par de quien acaba de recuperar su contraseña (RF-103): sin fallos y de confianza.
 * Quien recupera controla el buzón, y esta es su salida cuando el tope de la cuenta lo dejó
 * fuera en un dispositivo nuevo. El servicio borra además los demás pares de la cuenta y
 * su cuenta de la hora: la confianza de antes de recuperar ya no vale.
 */
export function pairAfterRecovery(now: Date): PairState {
  return { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: now };
}
