import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ACCOUNT_DENIALS, resolveAccountAccess, type AccountAccess, type AccountFacts } from "./account-access";

// La regla de acceso de una cuenta (RN-01, RF-203; TRD §5.1 y §12). Las fechas van en
// milisegundos desde un día fijo, y cada borde se prueba un milisegundo antes, en el instante
// y un milisegundo después: los intervalos son semiabiertos, [inicio, fin).

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (days: number, ms = 0) => new Date(T0 + days * DAY + ms);

const NOTHING: AccountFacts = {
  suspended: false,
  paidThrough: null,
  lastRenewalFailedAt: null,
  endedAt: null,
  refunded: false,
  courtesy: [],
};
const facts = (over: Partial<AccountFacts>): AccountFacts => ({ ...NOTHING, ...over });
const resolve = (over: Partial<AccountFacts>, now: Date, graceDays = 7) => resolveAccountAccess(facts(over), now, { graceDays });

describe("la suscripción: el periodo pagado, hasta su fin y sin incluirlo", () => {
  const paid = { paidThrough: at(30) };

  it.each<[string, Date, AccountAccess]>([
    ["un milisegundo antes del fin", at(30, -1), { allowed: true, basis: "subscription", until: at(30) }],
    ["en el instante del fin", at(30), { allowed: false, reason: "expired", endedAt: at(30) }],
    ["un milisegundo después", at(30, 1), { allowed: false, reason: "expired", endedAt: at(30) }],
  ])("%s", (_when, now, expected) => {
    expect(resolve(paid, now)).toEqual(expected);
  });

  it("cancelada con el periodo vigente: el acceso sigue hasta el fin del periodo", () => {
    // Cancelar no pone `endedAt`: la suscripción termina sola al fin del periodo (RF-204).
    expect(resolve(paid, at(10))).toEqual({ allowed: true, basis: "subscription", until: at(30) });
  });

  it("un reembolso corta en `endedAt` aunque el periodo siga pagado (RF-210)", () => {
    const refund = { ...paid, endedAt: at(10), refunded: true };
    expect(resolve(refund, at(10, -1))).toEqual({ allowed: true, basis: "subscription", until: at(10) });
    expect(resolve(refund, at(10))).toEqual({ allowed: false, reason: "refunded", endedAt: at(10) });
    expect(resolve(refund, at(40))).toEqual({ allowed: false, reason: "refunded", endedAt: at(10) });
  });

  it("un reembolso que no cortó nada (cobro duplicado) no cambia el motivo", () => {
    expect(resolve({ ...paid, refunded: true }, at(31))).toEqual({ allowed: false, reason: "expired", endedAt: at(30) });
  });

  it("un `endedAt` posterior al periodo no lo alarga", () => {
    expect(resolve({ ...paid, endedAt: at(50) }, at(31))).toEqual({ allowed: false, reason: "expired", endedAt: at(30) });
  });
});

describe("la gracia: desde la falla, `GRACIA_COBRO_DIAS` días de 24 horas, sin incluir el fin", () => {
  const failed = { paidThrough: at(30), lastRenewalFailedAt: at(30) };

  it.each<[string, Date, AccountAccess]>([
    ["al vencer el periodo, con la falla", at(30), { allowed: true, basis: "grace", until: at(37) }],
    ["un milisegundo antes del fin de la gracia", at(37, -1), { allowed: true, basis: "grace", until: at(37) }],
    ["en el instante del fin de la gracia", at(37), { allowed: false, reason: "grace_ended", endedAt: at(37) }],
    ["un milisegundo después", at(37, 1), { allowed: false, reason: "grace_ended", endedAt: at(37) }],
  ])("%s", (_when, now, expected) => {
    expect(resolve(failed, now)).toEqual(expected);
  });

  it("con la falla antes del fin del periodo, el periodo pagado manda mientras dure", () => {
    expect(resolve({ paidThrough: at(30), lastRenewalFailedAt: at(28) }, at(29))).toEqual({ allowed: true, basis: "subscription", until: at(30) });
    expect(resolve({ paidThrough: at(30), lastRenewalFailedAt: at(28) }, at(31))).toEqual({ allowed: true, basis: "grace", until: at(35) });
  });

  it("cancelar durante la gracia termina el acceso en el acto (RF-204, FL-20 A2)", () => {
    const cancelled = { ...failed, endedAt: at(33) };
    expect(resolve(cancelled, at(33, -1))).toEqual({ allowed: true, basis: "grace", until: at(33) });
    expect(resolve(cancelled, at(33))).toEqual({ allowed: false, reason: "grace_ended", endedAt: at(33) });
  });

  it("un reembolso durante la gracia también la corta, y dice que fue un reembolso", () => {
    expect(resolve({ ...failed, endedAt: at(32), refunded: true }, at(32))).toEqual({ allowed: false, reason: "refunded", endedAt: at(32) });
  });

  it("es de una renovación: sin un periodo pagado antes, una falla no da gracia", () => {
    expect(resolve({ lastRenewalFailedAt: at(0) }, at(3))).toEqual({ allowed: false, reason: "never_subscribed" });
  });

  it("y desde la falla: una con fecha futura no da gracia, ni cuenta para el motivo", () => {
    expect(resolve({ paidThrough: at(10), lastRenewalFailedAt: at(30) }, at(20))).toEqual({ allowed: false, reason: "expired", endedAt: at(10) });
    expect(resolve({ paidThrough: at(10), lastRenewalFailedAt: at(30) }, at(30))).toEqual({ allowed: true, basis: "grace", until: at(37) });
  });

  it("con cero días de gracia, la falla no da acceso", () => {
    expect(resolve(failed, at(30), 0)).toEqual({ allowed: false, reason: "grace_ended", endedAt: at(30) });
  });

  it("si llega una falla vieja (los avisos llegan en desorden), no hace decir «no pudimos cobrar»", () => {
    // Falló el día 30, se cobró, pagó hasta el 60, canceló, y ya es el 61; el motivo es el último fin.
    expect(resolve({ paidThrough: at(60), lastRenewalFailedAt: at(30) }, at(61))).toEqual({ allowed: false, reason: "expired", endedAt: at(60) });
  });

  it("si la gracia y el periodo terminan en el mismo instante, el motivo es la gracia", () => {
    expect(resolve({ paidThrough: at(37), lastRenewalFailedAt: at(30) }, at(40))).toEqual({ allowed: false, reason: "grace_ended", endedAt: at(37) });
  });
});

describe("la cortesía (RF-213): desde su inicio, hasta su fin o sin fin", () => {
  it.each<[string, Date, AccountAccess]>([
    ["un milisegundo antes de empezar", at(5, -1), { allowed: false, reason: "never_subscribed" }],
    ["al empezar", at(5), { allowed: true, basis: "courtesy", until: at(20) }],
    ["un milisegundo antes del fin", at(20, -1), { allowed: true, basis: "courtesy", until: at(20) }],
    ["en el fin", at(20), { allowed: false, reason: "never_subscribed" }],
  ])("%s", (_when, now, expected) => {
    expect(resolve({ courtesy: [{ from: at(5), until: at(20) }] }, now)).toEqual(expected);
  });

  it("una con fin antes de su inicio nunca da acceso", () => {
    expect(resolve({ courtesy: [{ from: at(10), until: at(5) }] }, at(7))).toEqual({ allowed: false, reason: "never_subscribed" });
  });

  it("`endedAt` no la corta: es de la suscripción", () => {
    const refundedWithCourtesy = { paidThrough: at(30), endedAt: at(10), refunded: true, courtesy: [{ from: at(0), until: null }] };
    expect(resolve(refundedWithCourtesy, at(11))).toEqual({ allowed: true, basis: "courtesy", until: null });
  });

  it("sin fecha de fin: sin fin", () => {
    expect(resolve({ courtesy: [{ from: at(0), until: null }] }, at(9999))).toEqual({ allowed: true, basis: "courtesy", until: null });
  });

  it("varias que se traslapan: hasta el fin más lejano de las vigentes, y sin fin si alguna no tiene", () => {
    const two = [
      { from: at(0), until: at(10) },
      { from: at(5), until: at(15) },
    ];
    expect(resolve({ courtesy: two }, at(6))).toEqual({ allowed: true, basis: "courtesy", until: at(15) });
    expect(resolve({ courtesy: [...two, { from: at(1), until: null }] }, at(6))).toEqual({ allowed: true, basis: "courtesy", until: null });
    // En cualquier orden.
    expect(resolve({ courtesy: [{ from: at(1), until: null }, ...two] }, at(6))).toEqual({ allowed: true, basis: "courtesy", until: null });
  });

  it("muchas a la vez no la tiran: se recorren, no se esparcen", () => {
    const many = Array.from({ length: 200_000 }, (_, index) => ({ from: at(0), until: at(10, index) }));
    expect(resolve({ courtesy: many }, at(1))).toEqual({ allowed: true, basis: "courtesy", until: at(10, 199_999) });
  });

  it("una que todavía no empieza no cuenta, ni para el fin de las vigentes", () => {
    const later = [
      { from: at(0), until: at(10) },
      { from: at(50), until: null },
    ];
    expect(resolve({ courtesy: later }, at(6))).toEqual({ allowed: true, basis: "courtesy", until: at(10) });
  });

  it("si terminó y nunca pagó, lo mismo que quien nunca se suscribió (decisión del 2026-10-15)", () => {
    expect(resolve({ courtesy: [{ from: at(0), until: at(10) }] }, at(11))).toEqual({ allowed: false, reason: "never_subscribed" });
  });

  it("si pagó antes, el motivo es el de su suscripción", () => {
    expect(resolve({ paidThrough: at(30), courtesy: [{ from: at(0), until: at(40) }] }, at(41))).toEqual({
      allowed: false,
      reason: "expired",
      endedAt: at(30),
    });
  });
});

describe("cuando aplican varias: suscripción, gracia, cortesía (decisión del 2026-10-15)", () => {
  const everything = {
    paidThrough: at(30),
    lastRenewalFailedAt: at(29),
    courtesy: [{ from: at(0), until: null }],
  };

  it("paga y tiene cortesía: cuenta como quien paga", () => {
    expect(resolve(everything, at(10))).toEqual({ allowed: true, basis: "subscription", until: at(30) });
  });

  it("en gracia y con cortesía: gracia", () => {
    expect(resolve(everything, at(31))).toEqual({ allowed: true, basis: "grace", until: at(36) });
  });

  it("sin suscripción ni gracia, la cortesía la sostiene", () => {
    expect(resolve(everything, at(40))).toEqual({ allowed: true, basis: "courtesy", until: null });
  });
});

describe("suspendida, nunca", () => {
  it("ni con todo vigente", () => {
    const all = { suspended: true, paidThrough: at(30), lastRenewalFailedAt: at(30), courtesy: [{ from: at(0), until: null }] };
    expect(resolve(all, at(10))).toEqual({ allowed: false, reason: "suspended" });
  });

  it("y sin nada, nunca se suscribió", () => {
    expect(resolve({}, at(0))).toEqual({ allowed: false, reason: "never_subscribed" });
  });
});

describe("lo que no tiene sentido no se da por bueno: «no se supo», nunca «paga»", () => {
  const invalid = new Date(Number.NaN);

  it.each<[string, Partial<AccountFacts>, Date, number]>([
    ["un fin de periodo inválido", { paidThrough: invalid }, at(0), 7],
    ["una falla inválida", { lastRenewalFailedAt: invalid }, at(0), 7],
    ["un fin inválido", { endedAt: invalid }, at(0), 7],
    ["una cortesía con inicio inválido", { courtesy: [{ from: invalid, until: null }] }, at(0), 7],
    ["una cortesía con fin inválido", { courtesy: [{ from: at(0), until: invalid }] }, at(0), 7],
    ["la hora inválida", {}, invalid, 7],
    ["días de gracia negativos", {}, at(0), -1],
    ["días de gracia con decimales", {}, at(0), 1.5],
    ["días de gracia que no son un número", {}, at(0), Number.NaN],
    ["días de gracia que se salen de las fechas", { lastRenewalFailedAt: at(0) }, at(0), 1e9],
  ])("%s", (_what, over, now, graceDays) => {
    expect(resolve(over, now, graceDays)).toEqual({ allowed: false, reason: "invalid_input" });
  });

  it("aun suspendida: primero se dice que no se supo", () => {
    expect(resolve({ suspended: true }, invalid)).toEqual({ allowed: false, reason: "invalid_input" });
    expect(resolve({ suspended: true, lastRenewalFailedAt: at(0) }, at(0), 1e9)).toEqual({ allowed: false, reason: "invalid_input" });
  });
});

describe("el ciclo completo de una cuenta, día por día (TRD §12)", () => {
  it("alta, pago, renovación, falla, recuperación, otra falla, cancelación, reanudar, cancelar en gracia, reembolso, suspensión, cortesía y reactivación", () => {
    // Cada paso: los hechos que la base tendría ese día, y lo que la regla contesta.
    const steps: [string, Partial<AccountFacts>, Date, AccountAccess][] = [
      ["alta sin pagar", {}, at(0), { allowed: false, reason: "never_subscribed" }],
      ["primer pago", { paidThrough: at(31) }, at(1), { allowed: true, basis: "subscription", until: at(31) }],
      ["renovación", { paidThrough: at(61) }, at(31), { allowed: true, basis: "subscription", until: at(61) }],
      ["la renovación falla", { paidThrough: at(61), lastRenewalFailedAt: at(61) }, at(62), { allowed: true, basis: "grace", until: at(68) }],
      ["se recupera dentro de la gracia", { paidThrough: at(91) }, at(64), { allowed: true, basis: "subscription", until: at(91) }],
      // FL-21 E2: la fecha límite es la de la falla; que un reintento no la mueva le toca a quien reúne los hechos.
      ["la renovación siguiente falla", { paidThrough: at(91), lastRenewalFailedAt: at(91) }, at(95), { allowed: true, basis: "grace", until: at(98) }],
      ["se recupera otra vez", { paidThrough: at(121) }, at(96), { allowed: true, basis: "subscription", until: at(121) }],
      // FL-20 A1: reanudar antes del fin no cambia el acceso; renueva al llegar el fin.
      ["reanuda antes del fin, y renueva", { paidThrough: at(151) }, at(122), { allowed: true, basis: "subscription", until: at(151) }],
      ["falla y cancela durante la gracia", { paidThrough: at(151), lastRenewalFailedAt: at(151), endedAt: at(153) }, at(153), { allowed: false, reason: "grace_ended", endedAt: at(153) }],
      // Una suscripción nueva: sus hechos son suyos, el fin de la anterior no la corta.
      ["se suscribe otra vez", { paidThrough: at(190) }, at(160), { allowed: true, basis: "subscription", until: at(190) }],
      ["pide un reembolso", { paidThrough: at(190), endedAt: at(162), refunded: true }, at(163), { allowed: false, reason: "refunded", endedAt: at(162) }],
      ["se suscribe, y la suspenden a mitad", { suspended: true, paidThrough: at(220) }, at(195), { allowed: false, reason: "suspended" }],
      ["levantan la suspensión", { paidThrough: at(220) }, at(196), { allowed: true, basis: "subscription", until: at(220) }],
      ["le dan una cortesía encima", { paidThrough: at(220), courtesy: [{ from: at(197), until: at(260) }] }, at(200), { allowed: true, basis: "subscription", until: at(220) }],
      ["vence lo pagado: la cortesía la sostiene", { paidThrough: at(220), courtesy: [{ from: at(197), until: at(260) }] }, at(230), { allowed: true, basis: "courtesy", until: at(260) }],
      ["termina todo", { paidThrough: at(220), courtesy: [{ from: at(197), until: at(260) }] }, at(270), { allowed: false, reason: "expired", endedAt: at(220) }],
      ["se reactiva", { paidThrough: at(300) }, at(271), { allowed: true, basis: "subscription", until: at(300) }],
    ];
    for (const [step, over, now, expected] of steps) {
      expect(resolve(over, now), step).toEqual(expected);
    }
  });
});

describe("la lista cerrada de motivos", () => {
  it("cada motivo de rechazo tiene un caso que lo produce", () => {
    const produced: Record<(typeof ACCOUNT_DENIALS)[number], AccountAccess> = {
      suspended: resolve({ suspended: true }, at(0)),
      never_subscribed: resolve({}, at(0)),
      expired: resolve({ paidThrough: at(1) }, at(2)),
      grace_ended: resolve({ paidThrough: at(1), lastRenewalFailedAt: at(1) }, at(9)),
      refunded: resolve({ paidThrough: at(9), endedAt: at(1), refunded: true }, at(2)),
      invalid_input: resolve({}, at(0), -1),
    };
    for (const [reason, answer] of Object.entries(produced)) {
      expect(answer, reason).toMatchObject({ allowed: false, reason });
    }
  });
});

describe("propiedades", () => {
  // Días enteros, y también un milisegundo antes y después: así la hora cae en los bordes.
  const date = fc.tuple(fc.integer({ min: -400, max: 400 }), fc.constantFrom(-1, 0, 0, 1)).map(([days, ms]) => at(days, ms));
  const maybe = fc.option(date, { nil: null });
  const accountFacts = fc.record({
    suspended: fc.boolean(),
    paidThrough: maybe,
    lastRenewalFailedAt: maybe,
    endedAt: maybe,
    refunded: fc.boolean(),
    courtesy: fc.array(fc.record({ from: date, until: maybe }), { maxLength: 3 }),
  });
  const graceDays = fc.integer({ min: 0, max: 60 });

  it("una cuenta suspendida nunca tiene acceso", () => {
    fc.assert(
      fc.property(accountFacts, date, graceDays, (account, now, days) => {
        expect(resolveAccountAccess({ ...account, suspended: true }, now, { graceDays: days }).allowed).toBe(false);
      }),
    );
  });

  it("con acceso, `until` es nulo o posterior a la hora; sin acceso, `endedAt` ya pasó", () => {
    fc.assert(
      fc.property(accountFacts, date, graceDays, (account, now, days) => {
        const answer = resolveAccountAccess(account, now, { graceDays: days });
        if (answer.allowed) {
          if (answer.until !== null) expect(answer.until.getTime()).toBeGreaterThan(now.getTime());
        } else if ("endedAt" in answer) {
          expect(answer.endedAt.getTime()).toBeLessThanOrEqual(now.getTime());
        }
      }),
    );
  });

  it("entre dos bordes de los hechos, la respuesta no cambia: ni la base, ni las fechas, ni el motivo", () => {
    fc.assert(
      fc.property(accountFacts, date, date, graceDays, (account, one, other, days) => {
        // Todos los instantes en que algo empieza o termina.
        const borders = [account.paidThrough, account.endedAt, account.lastRenewalFailedAt, ...account.courtesy.flatMap((window) => [window.from, window.until])]
          .filter((value): value is Date => value !== null)
          .map((value) => value.getTime());
        if (account.lastRenewalFailedAt !== null) borders.push(account.lastRenewalFailedAt.getTime() + days * DAY);
        const [a, b] = [one.getTime(), other.getTime()].sort((x, y) => x - y);
        // Solo si ningún borde cae en (a, b]: los dos instantes están en el mismo tramo.
        if (borders.some((border) => border > (a ?? 0) && border <= (b ?? 0))) return;
        expect(resolveAccountAccess(account, one, { graceDays: days })).toEqual(resolveAccountAccess(account, other, { graceDays: days }));
      }),
    );
  });

  it("nunca lanza, con cualquier cosa", () => {
    const anyDate = fc.oneof(date, fc.constant(new Date(Number.NaN)), fc.date({ noInvalidDate: false }));
    fc.assert(
      fc.property(
        fc.record({
          suspended: fc.boolean(),
          paidThrough: fc.option(anyDate, { nil: null }),
          lastRenewalFailedAt: fc.option(anyDate, { nil: null }),
          endedAt: fc.option(anyDate, { nil: null }),
          refunded: fc.boolean(),
          courtesy: fc.array(fc.record({ from: anyDate, until: fc.option(anyDate, { nil: null }) }), { maxLength: 3 }),
        }),
        anyDate,
        fc.oneof(fc.integer(), fc.double()),
        (account, now, days) => {
          expect(() => resolveAccountAccess(account, now, { graceDays: days })).not.toThrow();
        },
      ),
    );
  });
});
