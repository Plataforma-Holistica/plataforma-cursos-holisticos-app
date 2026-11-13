import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { plans as text } from "@/messages/es/plans";
import { t } from "@/messages/format";
import type { CheckoutPlan, Offer } from "@/services/billing/checkout";

import { planCardText, plansView, showcaseView, type PlansViewer } from "./view";

const OFFER: Offer = {
  plans: [
    { plan: "monthly", amountCents: 34900, lookupKey: "plataforma_monthly_34900_mxn", nextChargeAt: "2026-12-10T18:00:00Z" },
    { plan: "annual", amountCents: 349000, lookupKey: "plataforma_annual_349000_mxn", nextChargeAt: "2027-11-10T18:00:00Z" },
  ],
  recurring: { id: "11111111-2222-4333-8444-555555555555", version: 0, title: "Cobro recurrente", body: "…" },
  refundPolicy: "66666666-2222-4333-8444-555555555555",
  refundDays: 7,
};

const legal = (doc: "recurring" | "refund", version: number | null) => (doc === "recurring" ? `/legal/cobro-recurrente?v=${version}` : "/legal/reembolsos");
const PAY: PlansViewer = { kind: "pay" };

describe("PA-04, la vista", () => {
  it("sin plan elegido: dos tarjetas sin elegir y sin «Antes de pagar»", () => {
    const view = plansView(OFFER, { plan: null, returnTo: null, canceled: false }, PAY, legal);
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.cards.map((card) => [card.plan, card.chosen, card.href])).toEqual([
      ["monthly", false, "/planes?plan=monthly#bloque-pagar"],
      ["annual", false, "/planes?plan=annual#bloque-pagar"],
    ]);
    expect(view.summary).toBeNull();
    // Hacia arriba (decisión de Sergio del 2026-11-12): antes decía $290.83.
    expect(view.cards[1]?.equivalent).toBe("Equivale a $290.84 al mes.");
  });

  it("con el plan elegido, el formulario lleva el monto y el texto que se ven", () => {
    const view = plansView(OFFER, { plan: "annual", returnTo: "/cursos/uno", canceled: false }, PAY, legal);
    if (view.kind !== "ready") throw new Error("lista");
    expect(view.summary).toMatchObject({
      plan: "annual",
      price: "$3,490.00, IVA incluido",
      amount: 349000,
      document: OFFER.recurring?.id,
      consentHref: "/legal/cobro-recurrente?v=0",
      refundHref: "/legal/reembolsos",
      draft: true,
    });
    expect(view.summary?.nextCharge).toBe("10 de noviembre de 2027, por $3,490.00");
    expect(view.summary?.consent).toContain("cada año");
    expect(view.self).toBe("/planes?plan=annual&volver=%2Fcursos%2Funo");
    expect(view.cards.find((card) => card.plan === "monthly")?.href).toBe("/planes?plan=monthly&volver=%2Fcursos%2Funo#bloque-pagar");
  });

  it("al visitante le ofrece crear su cuenta o entrar, volviendo con el plan y el destino", () => {
    const view = plansView(OFFER, { plan: "monthly", returnTo: null, canceled: false }, { kind: "visitor", signUp: (to) => `/registro?volver=${to}`, signIn: (to) => `/entrar?volver=${to}` }, legal);
    if (view.kind !== "ready") throw new Error("lista");
    expect(view.who).toEqual({ kind: "visitor", signUp: "/registro?volver=/planes?plan=monthly", signIn: "/entrar?volver=/planes?plan=monthly" });
  });

  it("con un pago en confirmación, el enlace a cómo va solo si hay sesión de pago", () => {
    const withSession = plansView(OFFER, { plan: null, returnTo: null, canceled: false }, { kind: "in_progress", session: "cs_test_1" }, legal);
    const without = plansView(OFFER, { plan: null, returnTo: null, canceled: false }, { kind: "in_progress", session: null }, legal);
    expect(withSession.kind === "ready" && withSession.who).toEqual({ kind: "in_progress", href: "/suscripcion/confirmando?sesion=cs_test_1" });
    expect(without.kind === "ready" && without.who).toEqual({ kind: "in_progress", href: null });
  });

  it("sin planes o sin el texto del cobro recurrente, no se vende", () => {
    expect(plansView({ ...OFFER, plans: [] }, { plan: null, returnTo: null, canceled: false }, PAY, legal).kind).toBe("not_for_sale");
    expect(plansView({ ...OFFER, recurring: null }, { plan: "monthly", returnTo: null, canceled: false }, PAY, legal).kind).toBe("not_for_sale");
    expect(plansView(OFFER, { plan: "monthly", returnTo: null, canceled: false }, PAY, () => null).kind).toBe("not_for_sale");
  });

  it("sin la política o sus días, el reembolso no se dice", () => {
    const view = plansView({ ...OFFER, refundPolicy: null, refundDays: null }, { plan: "monthly", returnTo: null, canceled: false }, PAY, legal);
    if (view.kind !== "ready") throw new Error("lista");
    expect(view.summary).toMatchObject({ refund: null, refundHref: null, draft: true });
  });

  it("un texto publicado no lleva la nota de borrador", () => {
    const view = plansView({ ...OFFER, recurring: { ...OFFER.recurring!, version: 1 } }, { plan: "monthly", returnTo: null, canceled: false }, PAY, legal);
    expect(view.kind === "ready" && view.summary?.draft).toBe(false);
  });
});

describe("la vitrina de la portada (T-616, solicitud 4b)", () => {
  const READY = { kind: "ready" as const, plans: OFFER.plans.map(({ plan, amountCents }) => ({ plan, amountCents })), recurringVersion: 0 };

  it("cada tarjeta de la portada dice lo mismo que la de /planes, para la misma oferta", () => {
    const plan = fc.record({ plan: fc.constantFrom("monthly" as const, "annual" as const), amountCents: fc.integer({ min: 1, max: 10_000_000 }) });
    fc.assert(
      fc.property(fc.uniqueArray(plan, { minLength: 1, maxLength: 2, selector: (each) => each.plan }), (plans) => {
        const offer: Offer = { ...OFFER, plans: plans.map((each) => ({ ...each, lookupKey: "x", nextChargeAt: "2026-12-10T18:00:00Z" })) };
        const shown = showcaseView({ kind: "ready", plans, recurringVersion: OFFER.recurring!.version }, legal);
        const page = plansView(offer, { plan: null, returnTo: null, canceled: false }, PAY, legal);
        if (shown.kind !== "ready" || page.kind !== "ready") return false;
        // T-616, 3b-4: también el ahorro y el destacado, que la portada y /planes calculan con la misma función.
        const pick = (card: {
          plan: string;
          name: string;
          price: string;
          repeat: string;
          equivalent: string | null;
          featured: boolean;
          saving: string | null;
          href: string;
          chooseLabel: string;
        }) => ({
          plan: card.plan,
          featured: card.featured,
          saving: card.saving,
          name: card.name,
          price: card.price,
          repeat: card.repeat,
          equivalent: card.equivalent,
          href: card.href,
          chooseLabel: card.chooseLabel,
        });
        expect(shown.cards.map(pick)).toEqual(page.cards.map(pick));
        return true;
      }),
    );
  });

  it("el equivalente solo se dice de un total que es un entero positivo de centavos", () => {
    expect(planCardText("annual", 299000).equivalent).toBe("Equivale a $249.17 al mes.");
    for (const amount of [0, -1, -299000, 1.5, Number.NaN]) expect(planCardText("annual", amount).equivalent, String(amount)).toBeNull();
  });

  it("con los dos planes: una tarjeta por plan, cada una a elegirlo en /planes, sin el monto en la dirección", () => {
    const view = showcaseView(READY, legal);
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.cards.map((card) => [card.plan, card.href])).toEqual([
      ["monthly", "/planes?plan=monthly#bloque-pagar"],
      ["annual", "/planes?plan=annual#bloque-pagar"],
    ]);
    expect(view.cards[0]?.equivalent).toBeNull();
    expect(view.cards[1]?.equivalent).toBe("Equivale a $290.84 al mes.");
    for (const card of view.cards) expect(card.href).not.toMatch(/\d{3}/);
    // Cada enlace con su propio nombre.
    expect(new Set(view.cards.map((card) => card.chooseLabel)).size).toBe(2);
  });

  it("con un solo plan a la venta, una tarjeta", () => {
    const view = showcaseView({ ...READY, plans: [READY.plans[1]!] }, legal);
    expect(view.kind === "ready" && view.cards.map((card) => card.plan)).toEqual(["annual"]);
  });

  it("sin venta, con el criterio de /planes: sin planes, sin texto del cobro recurrente o sin su página, no se muestra", () => {
    expect(showcaseView({ ...READY, plans: [] }, legal)).toEqual({ kind: "hidden" });
    expect(showcaseView({ ...READY, recurringVersion: null }, legal)).toEqual({ kind: "hidden" });
    expect(showcaseView(READY, () => null)).toEqual({ kind: "hidden" });
    // Y /planes dice lo mismo de esa oferta.
    expect(plansView({ ...OFFER, recurring: null }, { plan: null, returnTo: null, canceled: false }, PAY, legal)).toEqual({ kind: "not_for_sale" });
  });

  it("si no se supo, sin cifras", () => {
    expect(showcaseView({ kind: "unavailable" }, legal)).toEqual({ kind: "unavailable" });
  });
});

// T-616, 3b-4: el anual destacado con su ahorro, por la misma función en /planes y en la portada. La marca no sale sin la cifra, ni
// la cifra sin la marca; destacar no elige ni entra en lo que se firma.
describe("el anual destacado y su ahorro (T-616, 3b-4)", () => {
  const offerOf = (plans: { plan: CheckoutPlan; amountCents: number }[]): Offer => ({
    ...OFFER,
    plans: plans.map((each) => ({ ...each, lookupKey: "x", nextChargeAt: "2026-12-10T18:00:00Z" })),
  });
  const ready = (offer: Offer, plan: CheckoutPlan | null = null) => {
    const view = plansView(offer, { plan, returnTo: null, canceled: false }, PAY, legal);
    if (view.kind !== "ready") throw new Error("lista");
    return view;
  };
  const SEED = [
    { plan: "monthly" as const, amountCents: 34900 },
    { plan: "annual" as const, amountCents: 299000 },
  ];

  it("con los precios de la semilla, el anual dice que ahorras $1,198 al año frente a doce meses del mensual", () => {
    const view = ready(offerOf(SEED));
    expect(view.cards.map((card) => [card.plan, card.featured, card.saving])).toEqual([
      ["monthly", false, null],
      ["annual", true, t(text.saving, { saving: "$1,198" })],
    ]);
  });

  it("la cifra sale de los montos de la oferta: con otros, otra", () => {
    const view = ready(offerOf([{ plan: "monthly", amountCents: 39900 }, { plan: "annual", amountCents: 399000 }]));
    expect(view.cards[1]?.saving).toBe(t(text.saving, { saving: "$798" }));
  });

  it("los planes se buscan por nombre, no por su lugar", () => {
    const view = ready(offerOf([...SEED].reverse()));
    expect(view.cards.map((card) => [card.plan, card.featured])).toEqual([
      ["annual", true],
      ["monthly", false],
    ]);
    expect(view.cards[0]?.saving).toBe(t(text.saving, { saving: "$1,198" }));
  });

  it("sin ahorro, ningún destacado ni cifra: igual o más caro, menos de un peso, un solo plan o un plan repetido", () => {
    for (const plans of [
      [{ plan: "monthly" as const, amountCents: 34900 }, { plan: "annual" as const, amountCents: 418800 }],
      [{ plan: "monthly" as const, amountCents: 34900 }, { plan: "annual" as const, amountCents: 500000 }],
      [{ plan: "monthly" as const, amountCents: 34900 }, { plan: "annual" as const, amountCents: 418701 }],
      [{ plan: "annual" as const, amountCents: 299000 }],
      [{ plan: "monthly" as const, amountCents: 34900 }],
      [...SEED, { plan: "annual" as const, amountCents: 199000 }],
    ]) {
      const view = ready(offerOf(plans));
      expect(view.cards.every((card) => !card.featured && card.saving === null && !card.primary), JSON.stringify(plans)).toBe(true);
      const shown = showcaseView({ kind: "ready", plans, recurringVersion: 0 }, legal);
      expect(shown.kind === "ready" && shown.cards.every((card) => !card.featured && card.saving === null), JSON.stringify(plans)).toBe(true);
    }
  });

  it("la marca va siempre con su cifra, solo en el anual (propiedad)", () => {
    const plan = fc.record({ plan: fc.constantFrom("monthly" as const, "annual" as const), amountCents: fc.integer({ min: 1, max: 999_999_999_999 }) });
    fc.assert(
      fc.property(fc.array(plan, { minLength: 1, maxLength: 3 }), (plans) => {
        const view = ready(offerOf(plans));
        return view.cards.every((card) => card.featured === (card.saving !== null) && (!card.featured || card.plan === "annual"));
      }),
    );
  });

  it("el botón principal es el del anual destacado solo sin plan elegido: elegido uno, la acción principal es pagar", () => {
    expect(ready(offerOf(SEED)).cards.map((card) => card.primary)).toEqual([false, true]);
    expect(ready(offerOf(SEED), "monthly").cards.map((card) => card.primary)).toEqual([false, false]);
    expect(ready(offerOf(SEED), "annual").cards.map((card) => card.primary)).toEqual([false, false]);
  });

  it("destacar no elige: sin plan en la dirección no hay «Antes de pagar», y con plan lo que se firma no lleva el ahorro", () => {
    expect(ready(offerOf(SEED)).summary).toBeNull();
    for (const plan of ["monthly", "annual"] as const) {
      const summary = ready(offerOf(SEED), plan).summary;
      expect(summary?.plan).toBe(plan);
      expect(JSON.stringify(summary)).not.toMatch(/1,198|1198|Ahorras/);
    }
  });

  it("en la portada, el anual destacado con su cifra, sin botón principal: ahí el principal es «Suscribirme»", () => {
    const shown = showcaseView({ kind: "ready", plans: SEED, recurringVersion: 0 }, legal);
    if (shown.kind !== "ready") throw new Error("lista");
    expect(shown.cards.map((card) => [card.plan, card.featured, card.saving])).toEqual([
      ["monthly", false, null],
      ["annual", true, t(text.saving, { saving: "$1,198" })],
    ]);
    expect(shown.cards.some((card) => "primary" in card)).toBe(false);
  });
});
