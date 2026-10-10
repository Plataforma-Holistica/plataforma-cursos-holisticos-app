import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type PairState,
  type SignInFacts,
  type ThrottleParams,
  decideSignInAttempt,
  pairAfterRecovery,
  settleSignIn,
} from "./login-throttle";

// El freno progresivo del inicio de sesión (RF-102, TRD §9.2 y §9.9). El freno vive en el
// par de cuenta y dirección; los topes por hora, en la dirección y en la cuenta. El intento
// se cuenta ANTES de preguntarle a Auth, como si fuera a fallar, y se cierra después: así
// cien peticiones a la vez no pasan todas.

// Los valores de 00-fundamentos §4, en segundos y días.
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

/** Un par que falla `count` veces seguidas, esperando cada vez a que el freno lo deje. */
function afterFailures(count: number, start = T0): { pair: PairState | null; now: Date } {
  let pair: PairState | null = null;
  let now = start;
  for (let i = 0; i < count; i += 1) {
    const decision = decideSignInAttempt({ ...fresh, pair }, now, params);
    if (!decision.proceed) throw new Error(`El intento ${i + 1} no procedió: ${decision.reason}`);
    pair = settleSignIn(decision, pair, "failure", now).pair;
    now = pair.lockedUntil ?? plus(now, 1);
  }
  return { pair, now };
}

describe("decideSignInAttempt", () => {
  it("el primer intento procede y se cuenta por adelantado, sin espera", () => {
    expect(decideSignInAttempt(fresh, T0, params)).toEqual({
      proceed: true,
      pair: { failedCount: 1, lockedUntil: null, lastFailedAt: T0, lastSuccessAt: null },
    });
  });

  it("los fallos por debajo del umbral no esperan", () => {
    const { pair } = afterFailures(4);
    expect(pair).toMatchObject({ failedCount: 4, lockedUntil: null });
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
    const { pair } = afterFailures(count);
    expect(pair?.failedCount).toBe(count);
    expect(pair?.lockedUntil).toEqual(plus(pair?.lastFailedAt ?? T0, wait));
  });

  it("frenado, el intento no procede y dice hasta cuándo", () => {
    const { pair } = afterFailures(5);
    const during = plus(pair?.lastFailedAt ?? T0, 30);
    expect(decideSignInAttempt({ ...fresh, pair }, during, params)).toEqual({
      proceed: false,
      reason: "throttled",
      retryAt: pair?.lockedUntil,
    });
  });

  it("en el instante en que termina la espera ya procede", () => {
    const { pair } = afterFailures(5);
    const decision = decideSignInAttempt({ ...fresh, pair }, pair?.lockedUntil ?? T0, params);
    expect(decision).toMatchObject({ proceed: true, pair: { failedCount: 6 } });
  });

  it("tras el olvido sin fallos, la cuenta de fallos vuelve a empezar", () => {
    const { pair } = afterFailures(7);
    const justBefore = plus(pair?.lastFailedAt ?? T0, params.forgetAfterSeconds - 1);
    const onTime = plus(pair?.lastFailedAt ?? T0, params.forgetAfterSeconds);
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

  it("el tope de la cuenta no frena a un par que entró bien dentro del plazo de confianza", () => {
    const trusted: PairState = { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: plus(T0, -3600) };
    expect(decideSignInAttempt({ pair: trusted, ipHitsThisHour: 0, accountHitsThisHour: 500 }, T0, params)).toMatchObject({
      proceed: true,
    });
  });

  it("la confianza se acaba al cumplirse el plazo, y una entrada con fecha futura no cuenta", () => {
    const days = params.trustDays * 86_400;
    const facts = (lastSuccessAt: Date): SignInFacts => ({
      pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt },
      ipHitsThisHour: 0,
      accountHitsThisHour: 20,
    });
    expect(decideSignInAttempt(facts(plus(T0, -days + 1)), T0, params)).toMatchObject({ proceed: true });
    expect(decideSignInAttempt(facts(plus(T0, -days)), T0, params)).toEqual({
      proceed: false,
      reason: "account_hourly_cap",
    });
    expect(decideSignInAttempt(facts(plus(T0, 60)), T0, params)).toEqual({
      proceed: false,
      reason: "account_hourly_cap",
    });
  });

  it("el tope de la dirección sí frena al par de confianza", () => {
    const trusted: PairState = { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: plus(T0, -3600) };
    expect(decideSignInAttempt({ pair: trusted, ipHitsThisHour: 20, accountHitsThisHour: 0 }, T0, params)).toEqual({
      proceed: false,
      reason: "ip_hourly_cap",
    });
  });

  it("si coinciden el freno y un tope, el motivo es el tope: su mensaje no promete una hora", () => {
    const { pair } = afterFailures(5);
    const during = plus(pair?.lastFailedAt ?? T0, 30);
    expect(decideSignInAttempt({ pair, ipHitsThisHour: 20, accountHitsThisHour: 0 }, during, params)).toEqual({
      proceed: false,
      reason: "ip_hourly_cap",
    });
    expect(decideSignInAttempt({ pair, ipHitsThisHour: 0, accountHitsThisHour: 20 }, during, params)).toEqual({
      proceed: false,
      reason: "account_hourly_cap",
    });
  });

  it("un fallo nuevo nunca acorta una espera que ya estaba puesta", () => {
    // Un estado que no debería existir: la espera va más allá de lo que tocaría.
    const odd: PairState = { failedCount: 5, lockedUntil: plus(T0, -1), lastFailedAt: plus(T0, -60), lastSuccessAt: null };
    const decision = decideSignInAttempt({ ...fresh, pair: odd }, T0, params);
    expect(decision).toMatchObject({ proceed: true, pair: { failedCount: 6, lockedUntil: plus(T0, 120) } });
  });

  it.each<[string, Partial<ThrottleParams>]>([
    ["un umbral de cero", { threshold: 0 }],
    ["un umbral que no es entero", { threshold: 2.5 }],
    ["una espera base de cero", { baseWaitSeconds: 0 }],
    ["una espera base que no es un número", { baseWaitSeconds: Number.NaN }],
    ["un tope de espera menor que la base", { maxWaitSeconds: 30 }],
    ["un tope de espera infinito", { maxWaitSeconds: Number.POSITIVE_INFINITY }],
    ["un olvido de cero", { forgetAfterSeconds: 0 }],
    ["un plazo de confianza negativo", { trustDays: -1 }],
    ["un tope por hora de cero", { hourlyCap: 0 }],
  ])("con %s no deja pasar a nadie", (_name, bad) => {
    expect(decideSignInAttempt(fresh, T0, { ...params, ...bad })).toEqual({ proceed: false, reason: "invalid_input" });
  });

  it.each<[string, SignInFacts, Date]>([
    ["un reloj inválido", fresh, new Date(Number.NaN)],
    ["una cuenta de la dirección negativa", { ...fresh, ipHitsThisHour: -1 }, T0],
    ["una cuenta de la cuenta que no es entera", { ...fresh, accountHitsThisHour: 0.5 }, T0],
    [
      "un par con una cuenta de fallos negativa",
      { ...fresh, pair: { failedCount: -1, lockedUntil: null, lastFailedAt: null, lastSuccessAt: null } },
      T0,
    ],
    [
      "un par con una fecha inválida",
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
});

describe("settleSignIn", () => {
  const before: PairState = { failedCount: 2, lockedUntil: null, lastFailedAt: plus(T0, -30), lastSuccessAt: null };
  const decision = decideSignInAttempt({ ...fresh, pair: before }, T0, params);
  if (!decision.proceed) throw new Error("El intento de la prueba debía proceder.");
  const now = plus(T0, 1);

  it("si falló, se queda lo que se contó por adelantado", () => {
    expect(settleSignIn(decision, before, "failure", now)).toEqual({
      pair: { failedCount: 3, lockedUntil: null, lastFailedAt: T0, lastSuccessAt: null },
      uncount: false,
    });
  });

  it("si entró bien, los fallos vuelven a cero, el par queda de confianza y el intento se descuenta", () => {
    expect(settleSignIn(decision, before, "success", now)).toEqual({
      pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: now },
      uncount: true,
    });
  });

  it("si no se supo, el par queda como estaba y el intento se descuenta", () => {
    expect(settleSignIn(decision, before, "unknown", now)).toEqual({ pair: before, uncount: true });
  });

  it("si no se supo y el par no existía, queda en blanco", () => {
    const first = decideSignInAttempt(fresh, T0, params);
    if (!first.proceed) throw new Error("El intento de la prueba debía proceder.");
    expect(settleSignIn(first, null, "unknown", now)).toEqual({
      pair: { failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: null },
      uncount: true,
    });
  });
});

describe("pairAfterRecovery", () => {
  it("quien recupera su contraseña queda sin fallos y como par de confianza", () => {
    expect(pairAfterRecovery(T0)).toEqual({ failedCount: 0, lockedUntil: null, lastFailedAt: null, lastSuccessAt: T0 });
  });
});

describe("el freno, como modelo", () => {
  const anyParams = fc
    .record({
      threshold: fc.integer({ min: 1, max: 8 }),
      baseWaitSeconds: fc.integer({ min: 1, max: 300 }),
      extra: fc.integer({ min: 0, max: 5000 }),
      forgetAfterSeconds: fc.integer({ min: 1, max: 7200 }),
      trustDays: fc.integer({ min: 1, max: 60 }),
      hourlyCap: fc.integer({ min: 1, max: 40 }),
    })
    .map(({ extra, ...rest }) => ({ ...rest, maxWaitSeconds: rest.baseWaitSeconds + extra }));

  it("la espera empieza en la base, se duplica y nunca pasa del tope ni se desborda", () => {
    fc.assert(
      fc.property(anyParams, fc.integer({ min: 1, max: 2_000_000_000 }), (random, failedCount) => {
        const state: PairState = {
          failedCount: failedCount - 1,
          lockedUntil: null,
          lastFailedAt: plus(T0, -1),
          lastSuccessAt: null,
        };
        fc.pre(random.forgetAfterSeconds > 1);
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
        expect(Number.isFinite(wait)).toBe(true);
      }),
    );
  });

  it("un intento que no procede no cambia nada, y fallar más nunca acorta la espera", () => {
    const step = fc.record({ seconds: fc.integer({ min: 0, max: 1200 }), outcome: fc.constantFrom("failure", "unknown") });
    fc.assert(
      fc.property(anyParams, fc.array(step, { maxLength: 60 }), (random, steps) => {
        let pair: PairState | null = null;
        let now = T0;
        let evaluated = 0;
        for (const { seconds, outcome } of steps) {
          now = plus(now, seconds);
          const decision = decideSignInAttempt({ pair, ipHitsThisHour: 0, accountHitsThisHour: 0 }, now, random);
          if (decision.proceed) {
            evaluated += 1;
            const previousLock: number = pair?.lockedUntil?.getTime() ?? 0;
            pair = settleSignIn(decision, pair, outcome as "failure" | "unknown", now).pair;
            // Dentro de una racha, la espera puesta nunca retrocede.
            if (outcome === "failure" && pair.failedCount > 1) {
              expect(pair.lockedUntil?.getTime() ?? 0).toBeGreaterThanOrEqual(Math.min(previousLock, now.getTime()));
            }
          } else {
            // Frenado: lo único que puede pasar es esperar. El estado no se toca.
            expect(decision.reason).toBe("throttled");
            expect(pair?.lockedUntil?.getTime() ?? 0).toBeGreaterThan(now.getTime());
          }
        }
        expect(evaluated).toBeLessThanOrEqual(steps.length);
      }),
    );
  });

  it("mientras dura una espera, ningún intento se evalúa", () => {
    fc.assert(
      fc.property(anyParams, fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 1000 }), (random, extra, offset) => {
        // Se llega justo al umbral, sin dejar pasar el plazo del olvido entre fallos.
        let pair: PairState | null = null;
        let now = T0;
        for (let i = 0; i < random.threshold + extra; i += 1) {
          const decision = decideSignInAttempt({ pair, ipHitsThisHour: 0, accountHitsThisHour: 0 }, now, random);
          fc.pre(decision.proceed);
          if (!decision.proceed) return;
          pair = settleSignIn(decision, pair, "failure", now).pair;
          now = pair.lockedUntil ?? now;
        }
        const locked = pair?.lockedUntil;
        fc.pre(locked !== null && locked !== undefined);
        if (!locked || !pair?.lastFailedAt) return;
        const span = locked.getTime() - pair.lastFailedAt.getTime();
        const inside = new Date(pair.lastFailedAt.getTime() + (offset % span));
        expect(decideSignInAttempt({ pair, ipHitsThisHour: 0, accountHitsThisHour: 0 }, inside, random)).toEqual({
          proceed: false,
          reason: "throttled",
          retryAt: locked,
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
        // Y con confianza, lo único que puede frenar es la dirección.
        if (!withTrust.proceed) expect(withTrust.reason).toBe("ip_hourly_cap");
      }),
    );
  });
});
