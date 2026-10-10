import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type PairState,
  type SignInFacts,
  type SignInOutcome,
  type ThrottleParams,
  decideSignInAttempt,
  pairAfterRecovery,
  settleSignIn,
} from "./login-throttle";

// El freno progresivo del inicio de sesión (RF-102, TRD §9.2 y §9.9). El freno vive en el
// par de cuenta y dirección; los topes por hora, en la dirección y en la cuenta. El intento
// se cuenta ANTES de preguntarle a Auth, como si fuera a fallar, y se cierra después: así
// cien peticiones a la vez no pasan todas.

// Valores de ejemplo para las pruebas, en segundos y días. Los de verdad viven en la tabla
// de parámetros y llegan como argumento.
const params: ThrottleParams = {
  threshold: 5,
  baseWaitSeconds: 60,
  maxWaitSeconds: 900,
  forgetAfterSeconds: 3600,
  trustDays: 30,
  hourlyCap: 20,
};

const T0 = new Date("2026-10-10T12:00:00.000Z");
const plus = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);
const fresh: SignInFacts = { pair: null, ipHitsThisHour: 0, accountHitsThisHour: 0 };

/**
 * La fila de un par, como la lleva el servicio: la decisión escribe su par antes de
 * preguntarle a Auth, y el cierre escribe encima solo si trae uno.
 */
function attempt(
  row: PairState | null,
  now: Date,
  outcome: SignInOutcome,
  using: ThrottleParams = params,
): { row: PairState | null; proceeded: boolean } {
  const decision = decideSignInAttempt({ pair: row, ipHitsThisHour: 0, accountHitsThisHour: 0 }, now, using);
  if (!decision.proceed) return { row, proceeded: false };
  return { row: settleSignIn(outcome, now).pair ?? decision.pair, proceeded: true };
}

/** Un par que falla `count` veces seguidas, esperando cada vez a que el freno lo deje. */
function afterFailures(count: number): PairState {
  let row: PairState | null = null;
  let now = T0;
  for (let i = 0; i < count; i += 1) {
    const result = attempt(row, now, "failure");
    if (!result.proceeded || result.row === null) throw new Error(`El intento ${i + 1} no procedió.`);
    row = result.row;
    now = row.lockedUntil ?? plus(now, 1);
  }
  if (row === null) throw new Error("Hace falta al menos un fallo.");
  return row;
}

const lastFailure = (pair: PairState): Date => {
  if (pair.lastFailedAt === null) throw new Error("El par no tiene un fallo anotado.");
  return pair.lastFailedAt;
};

describe("decideSignInAttempt", () => {
  it("el primer intento procede y se cuenta por adelantado, sin espera", () => {
    expect(decideSignInAttempt(fresh, T0, params)).toEqual({
      proceed: true,
      pair: { failedCount: 1, lockedUntil: null, lastFailedAt: T0, lastSuccessAt: null },
    });
  });

  it("los fallos por debajo del umbral no esperan", () => {
    expect(afterFailures(4)).toMatchObject({ failedCount: 4, lockedUntil: null });
  });

  it.each([
    [5, 60],
    [6, 120],
    [7, 240],
    [8, 480],
    [9, 900],
    [10, 900],
    [40, 900],
  ])("el fallo número %i espera %i segundos", (count, wait) => {
    const pair = afterFailures(count);
    expect(pair.failedCount).toBe(count);
    expect(pair.lockedUntil).toEqual(plus(lastFailure(pair), wait));
  });

  it("frenado, el intento no procede y dice hasta cuándo", () => {
    const pair = afterFailures(5);
    expect(decideSignInAttempt({ ...fresh, pair }, plus(lastFailure(pair), 30), params)).toEqual({
      proceed: false,
      reason: "throttled",
      retryAt: pair.lockedUntil,
    });
  });

  it("un milisegundo antes de que termine la espera sigue frenado; en el instante en que termina, procede", () => {
    const pair = afterFailures(5);
    const end = plus(lastFailure(pair), 60);
    expect(decideSignInAttempt({ ...fresh, pair }, new Date(end.getTime() - 1), params)).toMatchObject({
      proceed: false,
      reason: "throttled",
    });
    expect(decideSignInAttempt({ ...fresh, pair }, end, params)).toMatchObject({
      proceed: true,
      pair: { failedCount: 6 },
    });
  });

  it("tras el olvido sin fallos, la cuenta de fallos vuelve a empezar", () => {
    const pair = afterFailures(7);
    const justBefore = plus(lastFailure(pair), params.forgetAfterSeconds - 1);
    const onTime = plus(lastFailure(pair), params.forgetAfterSeconds);
    expect(decideSignInAttempt({ ...fresh, pair }, justBefore, params)).toMatchObject({
      proceed: true,
      pair: { failedCount: 8 },
    });
    expect(decideSignInAttempt({ ...fresh, pair }, onTime, params)).toMatchObject({
      proceed: true,
      pair: { failedCount: 1, lockedUntil: null },
    });
  });

  it("el olvido borra los fallos pero no la confianza", () => {
    const pair: PairState = {
      failedCount: 6,
      lockedUntil: plus(T0, 120),
      lastFailedAt: T0,
      lastSuccessAt: plus(T0, -86_400),
    };
    const later = plus(T0, params.forgetAfterSeconds);
    const decision = decideSignInAttempt({ pair, ipHitsThisHour: 0, accountHitsThisHour: 99 }, later, params);
    expect(decision).toMatchObject({ proceed: true, pair: { failedCount: 1, lastSuccessAt: plus(T0, -86_400) } });
  });

  it("con el tope de la dirección ya contado, no procede", () => {
    expect(decideSignInAttempt({ ...fresh, ipHitsThisHour: 20 }, T0, params)).toEqual({
      proceed: false,
      reason: "ip_hourly_cap",
    });
    expect(decideSignInAttempt({ ...fresh, ipHitsThisHour: 19 }, T0, params)).toMatchObject({ proceed: true });
  });

  it("con el tope de la cuenta ya contado, un par sin confianza no procede", () => {
    expect(decideSignInAttempt({ ...fresh, accountHitsThisHour: 20 }, T0, params)).toEqual({
      proceed: false,
      reason: "account_hourly_cap",
    });
    expect(decideSignInAttempt({ ...fresh, accountHitsThisHour: 19 }, T0, params)).toMatchObject({ proceed: true });
  });

  it("si los dos topes están llenos, el motivo es el de la dirección", () => {
    expect(decideSignInAttempt({ pair: null, ipHitsThisHour: 20, accountHitsThisHour: 20 }, T0, params)).toEqual({
      proceed: false,
      reason: "ip_hourly_cap",
    });
  });

  it("el tope de la cuenta no frena a un par que entró bien dentro del plazo de confianza", () => {
    const trusted: PairState = { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: plus(T0, -3600) };
    expect(decideSignInAttempt({ pair: trusted, ipHitsThisHour: 0, accountHitsThisHour: 500 }, T0, params)).toMatchObject({
      proceed: true,
    });
  });

  it("la confianza vale desde el mismo instante de la entrada, se acaba al cumplirse el plazo, y una fecha futura no cuenta", () => {
    const days = params.trustDays * 86_400;
    const facts = (lastSuccessAt: Date): SignInFacts => ({
      pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt },
      ipHitsThisHour: 0,
      accountHitsThisHour: 20,
    });
    const denied = { proceed: false, reason: "account_hourly_cap" };
    expect(decideSignInAttempt(facts(T0), T0, params)).toMatchObject({ proceed: true });
    expect(decideSignInAttempt(facts(plus(T0, -days + 1)), T0, params)).toMatchObject({ proceed: true });
    expect(decideSignInAttempt(facts(plus(T0, -days)), T0, params)).toEqual(denied);
    expect(decideSignInAttempt(facts(new Date(T0.getTime() + 1)), T0, params)).toEqual(denied);
  });

  it("el tope de la dirección sí frena al par de confianza", () => {
    const trusted: PairState = { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: plus(T0, -3600) };
    expect(decideSignInAttempt({ pair: trusted, ipHitsThisHour: 20, accountHitsThisHour: 0 }, T0, params)).toEqual({
      proceed: false,
      reason: "ip_hourly_cap",
    });
  });

  it("si coinciden el freno y un tope, el motivo es el tope: su mensaje no promete una hora", () => {
    const pair = afterFailures(5);
    const during = plus(lastFailure(pair), 30);
    expect(decideSignInAttempt({ pair, ipHitsThisHour: 20, accountHitsThisHour: 0 }, during, params)).toEqual({
      proceed: false,
      reason: "ip_hourly_cap",
    });
    expect(decideSignInAttempt({ pair, ipHitsThisHour: 0, accountHitsThisHour: 20 }, during, params)).toEqual({
      proceed: false,
      reason: "account_hourly_cap",
    });
  });

  it("una espera ya puesta se respeta entera, aunque el reloj retroceda", () => {
    const pair = afterFailures(5);
    const before = plus(lastFailure(pair), -600);
    expect(decideSignInAttempt({ ...fresh, pair }, before, params)).toEqual({
      proceed: false,
      reason: "throttled",
      retryAt: pair.lockedUntil,
    });
  });

  it.each<[string, Partial<ThrottleParams>]>([
    ["un umbral de cero", { threshold: 0 }],
    ["un umbral que no es entero", { threshold: 2.5 }],
    ["una espera base de cero", { baseWaitSeconds: 0 }],
    ["una espera base que no es un número", { baseWaitSeconds: Number.NaN }],
    ["un tope de espera menor que la base", { maxWaitSeconds: 30 }],
    ["un tope de espera infinito", { maxWaitSeconds: Number.POSITIVE_INFINITY }],
    ["un tope de espera que no cabe en un entero exacto", { maxWaitSeconds: 1e300, forgetAfterSeconds: Number.MAX_SAFE_INTEGER }],
    ["un olvido de cero", { forgetAfterSeconds: 0 }],
    ["un olvido igual a la espera más larga, que desarma la escalada", { forgetAfterSeconds: 900 }],
    ["un olvido menor que la espera más larga", { forgetAfterSeconds: 600 }],
    ["un plazo de confianza de cero", { trustDays: 0 }],
    ["un plazo de confianza negativo", { trustDays: -1 }],
    ["un tope por hora de cero", { hourlyCap: 0 }],
  ])("con %s no deja pasar a nadie", (_name, bad) => {
    expect(decideSignInAttempt(fresh, T0, { ...params, ...bad })).toEqual({ proceed: false, reason: "invalid_input" });
  });

  it.each<[string, SignInFacts, Date]>([
    ["un reloj inválido", fresh, new Date(Number.NaN)],
    ["un reloj en el borde de lo que cabe en una fecha", { ...fresh, pair: { failedCount: 9, lockedUntil: null, lastFailedAt: new Date(8.64e15), lastSuccessAt: null } }, new Date(8.64e15)],
    ["una cuenta de la dirección negativa", { ...fresh, ipHitsThisHour: -1 }, T0],
    ["una cuenta de la cuenta que no es entera", { ...fresh, accountHitsThisHour: 0.5 }, T0],
    [
      "un par con una cuenta de fallos negativa",
      { ...fresh, pair: { failedCount: -1, lockedUntil: null, lastFailedAt: null, lastSuccessAt: null } },
      T0,
    ],
    [
      "un par con la fecha de la espera inválida",
      { ...fresh, pair: { failedCount: 1, lockedUntil: new Date(Number.NaN), lastFailedAt: T0, lastSuccessAt: null } },
      T0,
    ],
    [
      "un par con la fecha del último fallo inválida",
      { ...fresh, pair: { failedCount: 1, lockedUntil: null, lastFailedAt: new Date(Number.NaN), lastSuccessAt: null } },
      T0,
    ],
    [
      "un par con la fecha de la última entrada inválida",
      { ...fresh, pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: new Date(Number.NaN) } },
      T0,
    ],
  ])("con %s no deja pasar a nadie", (_name, facts, now) => {
    expect(decideSignInAttempt(facts, now, params)).toEqual({ proceed: false, reason: "invalid_input" });
  });

  it("no altera los hechos que recibe, ni comparte estado entre llamadas", () => {
    const first = decideSignInAttempt(fresh, T0, params);
    const second = decideSignInAttempt(fresh, T0, params);
    if (!first.proceed || !second.proceed) throw new Error("Los dos intentos debían proceder.");
    expect(first.pair).not.toBe(second.pair);
    first.pair.failedCount = 99;
    first.pair.lastSuccessAt = T0;
    expect(decideSignInAttempt(fresh, T0, params)).toEqual({
      proceed: true,
      pair: { failedCount: 1, lockedUntil: null, lastFailedAt: T0, lastSuccessAt: null },
    });
    expect(fresh).toEqual({ pair: null, ipHitsThisHour: 0, accountHitsThisHour: 0 });
  });
});

describe("settleSignIn", () => {
  const now = plus(T0, 1);

  it("si falló, no hay nada que escribir: ya se contó por adelantado", () => {
    expect(settleSignIn("failure", now)).toEqual({ pair: null, uncount: false });
  });

  it("si entró bien, los fallos vuelven a cero, el par queda de confianza y el intento se descuenta", () => {
    expect(settleSignIn("success", now)).toEqual({
      pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: now },
      uncount: true,
    });
  });

  it("si no se supo, el par se queda con el intento contado y solo se descuenta de los topes", () => {
    expect(settleSignIn("unknown", now)).toEqual({ pair: null, uncount: true });
  });

  it("si entró bien pero el reloj es inválido, el par no se toca", () => {
    expect(settleSignIn("success", new Date(Number.NaN))).toEqual({ pair: null, uncount: true });
  });

  // El cierre llega en otra transacción, cuando otros intentos del mismo par ya escribieron.
  // Cinco intentos decididos en serie y cerrados en cualquier orden tienen que dejar la
  // misma espera que si se hubieran cerrado en orden.
  it("cerrar fallos en desorden no borra la espera que dejaron", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3, 4], { minLength: 5 }), (order) => {
        let row: PairState | null = null;
        for (let i = 0; i < 5; i += 1) {
          const decision = decideSignInAttempt({ ...fresh, pair: row }, T0, params);
          if (!decision.proceed) throw new Error("Las cinco decisiones debían proceder: aún no hay espera.");
          row = decision.pair;
        }
        const written = row;
        // Cada cierre llega cuando le toca según `order`; ninguno trae nada que escribir.
        order.forEach((position) => {
          row = settleSignIn("failure", plus(T0, position + 1)).pair ?? row;
        });
        expect(row).toEqual(written);
        expect(row).toMatchObject({ failedCount: 5, lockedUntil: plus(T0, 60) });
        expect(decideSignInAttempt({ ...fresh, pair: row }, plus(T0, 2), params)).toMatchObject({
          proceed: false,
          reason: "throttled",
        });
      }),
    );
  });

  it("un resultado desconocido que llega tarde no borra los fallos que hubo después", () => {
    let row: PairState | null = null;
    const pending = decideSignInAttempt({ ...fresh, pair: row }, T0, params);
    if (!pending.proceed) throw new Error("El primer intento debía proceder.");
    row = pending.pair;
    for (let i = 0; i < 3; i += 1) row = attempt(row, plus(T0, i + 1), "failure").row;
    row = settleSignIn("unknown", plus(T0, 10)).pair ?? row;
    expect(row).toMatchObject({ failedCount: 4 });
  });

  it("un fallo que se cierra después de recuperar no devuelve la confianza que la recuperación borró", () => {
    const trusted: PairState = { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: plus(T0, -3600) };
    const inFlight = decideSignInAttempt({ ...fresh, pair: trusted }, T0, params);
    expect(inFlight.proceed).toBe(true);
    // La recuperación, desde otro dispositivo, borra este par. El cierre no lo reescribe.
    let row: PairState | null = null;
    row = settleSignIn("failure", plus(T0, 5)).pair ?? row;
    expect(row).toBeNull();
    expect(decideSignInAttempt({ pair: row, ipHitsThisHour: 0, accountHitsThisHour: 20 }, plus(T0, 6), params)).toEqual({
      proceed: false,
      reason: "account_hourly_cap",
    });
  });
});

describe("pairAfterRecovery", () => {
  it("quien recupera su contraseña queda sin fallos y como par de confianza", () => {
    expect(pairAfterRecovery(T0)).toEqual({
      ok: true,
      pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: T0 },
    });
  });

  it("con un reloj inválido no da un par", () => {
    expect(pairAfterRecovery(new Date(Number.NaN))).toEqual({ ok: false, reason: "invalid_clock" });
  });

  it("el par de quien recupera pasa el tope de la cuenta, que es para lo que existe", () => {
    const recovered = pairAfterRecovery(T0);
    if (!recovered.ok) throw new Error("La recuperación debía dar un par.");
    expect(
      decideSignInAttempt({ pair: recovered.pair, ipHitsThisHour: 0, accountHitsThisHour: 500 }, plus(T0, 5), params),
    ).toMatchObject({ proceed: true });
  });
});

describe("el freno, como modelo", () => {
  const anyParams = fc
    .record({
      threshold: fc.integer({ min: 1, max: 8 }),
      baseWaitSeconds: fc.integer({ min: 1, max: 300 }),
      extraWait: fc.integer({ min: 0, max: 5000 }),
      extraForget: fc.integer({ min: 1, max: 7200 }),
      trustDays: fc.integer({ min: 1, max: 60 }),
      hourlyCap: fc.integer({ min: 1, max: 40 }),
    })
    .map(({ extraWait, extraForget, ...rest }) => ({
      ...rest,
      maxWaitSeconds: rest.baseWaitSeconds + extraWait,
      forgetAfterSeconds: rest.baseWaitSeconds + extraWait + extraForget,
    }));

  it("la espera empieza en la base, se duplica y nunca pasa del tope ni se desborda", () => {
    fc.assert(
      fc.property(anyParams, fc.integer({ min: 1, max: 2_000_000_000 }), (random, failedCount) => {
        const state: PairState = {
          failedCount: failedCount - 1,
          lockedUntil: null,
          lastFailedAt: plus(T0, -1),
          lastSuccessAt: null,
        };
        const decision = decideSignInAttempt({ ...fresh, pair: state }, T0, random);
        expect(decision.proceed).toBe(true);
        if (!decision.proceed) return;
        const wait = decision.pair.lockedUntil === null ? 0 : (decision.pair.lockedUntil.getTime() - T0.getTime()) / 1000;
        // El oráculo es la recurrencia, no la fórmula: se duplica paso a paso hasta el tope.
        let expected = 0;
        if (failedCount >= random.threshold) {
          expected = random.baseWaitSeconds;
          for (let n = random.threshold; n < failedCount && expected < random.maxWaitSeconds; n += 1) expected *= 2;
          expected = Math.min(expected, random.maxWaitSeconds);
        }
        expect(wait).toBe(expected);
      }),
    );
  });

  // Lo que el freno promete, medido desde fuera: en cualquier tramo de tiempo, por mucho
  // que alguien insista, los intentos que llegan a evaluarse no pasan de los que caben
  // entre espera y espera.
  it("por mucho que se insista, solo se evalúan los intentos que el freno deja pasar", () => {
    const step = fc.record({ seconds: fc.integer({ min: 0, max: 30 }), outcome: fc.constantFrom<SignInOutcome>("failure", "unknown") });
    fc.assert(
      fc.property(anyParams, fc.array(step, { minLength: 20, maxLength: 80 }), (random, steps) => {
        let row: PairState | null = null;
        let now = T0;
        let previousLock = 0;
        let lastEvaluatedAt = Number.NEGATIVE_INFINITY;
        for (const { seconds, outcome } of steps) {
          now = plus(now, seconds);
          const before = row;
          const result = attempt(row, now, outcome, random);
          row = result.row;
          if (!result.proceeded) {
            // Negado: el estado es exactamente el mismo objeto que había, y sigue frenado.
            expect(row).toBe(before);
            expect(now.getTime()).toBeLessThan(previousLock);
            continue;
          }
          // Evaluado: nunca antes de que terminara la espera que estaba puesta.
          expect(now.getTime()).toBeGreaterThanOrEqual(previousLock);
          expect(now.getTime()).toBeGreaterThanOrEqual(lastEvaluatedAt);
          lastEvaluatedAt = now.getTime();
          // Los tramos son cortos y el olvido es más largo que cualquier espera: la racha
          // no se rompe, así que cada fallo evaluado deja una espera igual o más larga.
          const lock = row?.lockedUntil?.getTime() ?? 0;
          if (lock !== 0) expect(lock - now.getTime()).toBeGreaterThanOrEqual(random.baseWaitSeconds * 1000);
          previousLock = lock;
        }
      }),
    );
  });

  it("mientras dura una espera, ningún intento se evalúa", () => {
    fc.assert(
      fc.property(anyParams, fc.integer({ min: 0, max: 40 }), fc.nat(), (random, extra, offset) => {
        let row: PairState | null = null;
        let now = T0;
        for (let i = 0; i < random.threshold + extra; i += 1) {
          const result = attempt(row, now, "failure", random);
          if (!result.proceeded || result.row === null) throw new Error("Cada fallo debía proceder: se espera a que el freno lo deje.");
          row = result.row;
          now = row.lockedUntil ?? now;
        }
        if (row === null || row.lockedUntil === null || row.lastFailedAt === null) {
          throw new Error("Pasado el umbral, el par tiene que estar frenado.");
        }
        const span = row.lockedUntil.getTime() - row.lastFailedAt.getTime();
        const inside = new Date(row.lastFailedAt.getTime() + (offset % span));
        expect(decideSignInAttempt({ pair: row, ipHitsThisHour: 0, accountHitsThisHour: 0 }, inside, random)).toEqual({
          proceed: false,
          reason: "throttled",
          retryAt: row.lockedUntil,
        });
      }),
    );
  });

  it("la confianza nunca endurece: lo que procede sin ella, procede con ella", () => {
    const hits = fc.integer({ min: 0, max: 60 });
    fc.assert(
      fc.property(anyParams, hits, hits, (random, ipHits, accountHits) => {
        const trusted: PairState = { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: plus(T0, -1) };
        const without = decideSignInAttempt({ pair: null, ipHitsThisHour: ipHits, accountHitsThisHour: accountHits }, T0, random);
        const withTrust = decideSignInAttempt(
          { pair: trusted, ipHitsThisHour: ipHits, accountHitsThisHour: accountHits },
          T0,
          random,
        );
        if (without.proceed) expect(withTrust.proceed).toBe(true);
        // Con confianza, lo único que puede frenar es la dirección; y sin ella, la cuenta
        // llena frena siempre que la dirección no lo haya hecho antes.
        if (!withTrust.proceed) expect(withTrust.reason).toBe("ip_hourly_cap");
        if (ipHits < random.hourlyCap && accountHits >= random.hourlyCap) {
          expect(without).toEqual({ proceed: false, reason: "account_hourly_cap" });
          expect(withTrust.proceed).toBe(true);
        }
      }),
    );
  });
});
