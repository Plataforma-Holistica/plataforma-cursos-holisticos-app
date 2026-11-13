import { afterEach, describe, expect, it, vi } from "vitest";

import type { Offer } from "./checkout";
import { createPlanShowcase, SHOWCASE_FAILURE_MEMORY_MS, SHOWCASE_MEMORY_MS, SHOWCASE_READ_TIMEOUT_MS } from "./showcase";

// Los precios de la portada (T-616, solicitud 4b), con la base simulada y el reloj en la mano. Una memoria corta para la página más
// visitada: a lo más una lectura por minuto y por instancia, también cuando no se pudo leer. `/planes` y la salida a pagar no la usan
// (lo exige tests/architecture/billing.test.ts).

const OFFER: Offer = {
  plans: [
    { plan: "monthly", amountCents: 34900, lookupKey: "mensual-v1", nextChargeAt: "2026-12-12T06:00:00.000Z" },
    { plan: "annual", amountCents: 299000, lookupKey: "anual-v1", nextChargeAt: "2027-11-12T06:00:00.000Z" },
  ],
  recurring: { id: "a0000000-0000-4000-8000-000000000001", version: 2, title: "Cobro recurrente", body: "Texto." },
  refundPolicy: "Reembolso.",
  refundDays: 14,
};

function setup(read: () => Promise<Offer> = () => Promise.resolve(OFFER)) {
  let clock = 1_000_000;
  const offer = vi.fn(read);
  const reported: string[] = [];
  const report = vi.fn((code: string) => (reported.push(code), Promise.resolve()));
  const { planShowcase } = createPlanShowcase({ offer, report, now: () => clock });
  return {
    planShowcase,
    offer,
    report,
    reported,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("planShowcase", () => {
  it("contesta solo lo que la portada pinta: el plan, su total y la versión del texto del cobro recurrente", async () => {
    const { planShowcase } = setup();
    expect(await planShowcase()).toStrictEqual({
      kind: "ready",
      plans: [
        { plan: "monthly", amountCents: 34900 },
        { plan: "annual", amountCents: 299000 },
      ],
      recurringVersion: 2,
    });
  });

  it("sin texto vigente del cobro recurrente, la versión es nula; con un solo plan, un solo plan", async () => {
    const { planShowcase } = setup(() => Promise.resolve({ ...OFFER, plans: [OFFER.plans[0]!], recurring: null }));
    expect(await planShowcase()).toStrictEqual({ kind: "ready", plans: [{ plan: "monthly", amountCents: 34900 }], recurringVersion: null });
  });

  it("recuerda lo leído un minuto: antes no vuelve a leer, al cumplirse sí", async () => {
    const { planShowcase, offer, advance } = setup();
    await planShowcase();
    advance(SHOWCASE_MEMORY_MS - 1);
    await planShowcase();
    expect(offer).toHaveBeenCalledTimes(1);
    advance(1);
    await planShowcase();
    expect(offer).toHaveBeenCalledTimes(2);
  });

  it("muchas visitas a la vez hacen una sola lectura, y todas reciben lo mismo", async () => {
    let finish!: (offer: Offer) => void;
    const { planShowcase, offer } = setup(() => new Promise<Offer>((resolve) => (finish = resolve)));
    const visits = [planShowcase(), planShowcase(), planShowcase()];
    finish(OFFER);
    const answers = await Promise.all(visits);
    expect(offer).toHaveBeenCalledTimes(1);
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]!.kind).toBe("ready");
  });

  it("si no se pudo leer, contesta que no se supo y lo reporta una vez, aunque esperaran varias visitas", async () => {
    let fail!: (error: Error) => void;
    const { planShowcase, reported } = setup(() => new Promise<Offer>((_resolve, reject) => (fail = reject)));
    const visits = [planShowcase(), planShowcase(), planShowcase()];
    fail(new Error("sin base"));
    expect(await Promise.all(visits)).toEqual([{ kind: "unavailable" }, { kind: "unavailable" }, { kind: "unavailable" }]);
    expect(reported).toEqual(["plans_showcase_unavailable"]);
  });

  it("el «no se supo» se recuerda menos: 15 s sin leer ni reportar; después lee, y si la base volvió, contesta los precios", async () => {
    let down = true;
    const { planShowcase, offer, reported, advance } = setup(() => (down ? Promise.reject(new Error("sin base")) : Promise.resolve(OFFER)));
    expect(await planShowcase()).toEqual({ kind: "unavailable" });
    advance(SHOWCASE_FAILURE_MEMORY_MS - 1);
    expect(await planShowcase()).toEqual({ kind: "unavailable" });
    expect(offer).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
    down = false;
    advance(1);
    expect((await planShowcase()).kind).toBe("ready");
    expect(offer).toHaveBeenCalledTimes(2);
    expect(reported).toHaveLength(1);
  });

  it("nunca rechaza: tampoco si reportar falla", async () => {
    let clock = 0;
    const { planShowcase } = createPlanShowcase({
      offer: () => Promise.reject(new Error("sin base")),
      report: () => Promise.reject(new Error("sin registro de errores")),
      now: () => clock,
    });
    await expect(planShowcase()).resolves.toEqual({ kind: "unavailable" });
    clock += SHOWCASE_FAILURE_MEMORY_MS;
    await expect(planShowcase()).resolves.toEqual({ kind: "unavailable" });
  });

  describe("una lectura que nunca termina", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("se corta a los 3 s: contesta que no se supo, lo reporta y suelta la lectura; la siguiente vez vencida lee otra vez", async () => {
      vi.useFakeTimers();
      let hang = true;
      const { planShowcase, offer, reported, advance } = setup(() => (hang ? new Promise<Offer>(() => undefined) : Promise.resolve(OFFER)));
      const visits = [planShowcase(), planShowcase()];
      await vi.advanceTimersByTimeAsync(SHOWCASE_READ_TIMEOUT_MS - 1);
      let settled = false;
      void Promise.all(visits).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await Promise.all(visits)).toEqual([{ kind: "unavailable" }, { kind: "unavailable" }]);
      expect(reported).toEqual(["plans_showcase_unavailable"]);
      // La base volvió: pasado el recuerdo de la falla, otra lectura, y no la que quedó colgada.
      hang = false;
      advance(SHOWCASE_FAILURE_MEMORY_MS);
      expect((await planShowcase()).kind).toBe("ready");
      expect(offer).toHaveBeenCalledTimes(2);
    });

    it("si la lectura cortada llega tarde, no pisa lo que se leyó después", async () => {
      vi.useFakeTimers();
      let late!: (offer: Offer) => void;
      const NEWER: Offer = { ...OFFER, plans: [{ ...OFFER.plans[0]!, amountCents: 39900 }] };
      const reads = [new Promise<Offer>((resolve) => (late = resolve)), Promise.resolve(NEWER)];
      const { planShowcase, advance } = setup(() => reads.shift()!);
      const first = planShowcase();
      await vi.advanceTimersByTimeAsync(SHOWCASE_READ_TIMEOUT_MS);
      expect(await first).toEqual({ kind: "unavailable" });
      advance(SHOWCASE_FAILURE_MEMORY_MS);
      const second = await planShowcase();
      expect(second.kind === "ready" && second.plans[0]?.amountCents).toBe(39900);
      late(OFFER);
      await vi.advanceTimersByTimeAsync(0);
      const third = await planShowcase();
      expect(third.kind === "ready" && third.plans[0]?.amountCents).toBe(39900);
    });
  });

  it("si el reloj va hacia atrás, lo recordado no vale: vuelve a leer", async () => {
    const { planShowcase, offer, advance } = setup();
    await planShowcase();
    advance(-1);
    await planShowcase();
    expect(offer).toHaveBeenCalledTimes(2);
  });

  it("después de una lectura terminada, la siguiente vencida lee otra vez: no se queda con la promesa de antes", async () => {
    const { planShowcase, offer, advance } = setup();
    await planShowcase();
    advance(SHOWCASE_MEMORY_MS);
    await planShowcase();
    advance(SHOWCASE_MEMORY_MS);
    await planShowcase();
    expect(offer).toHaveBeenCalledTimes(3);
  });
});
