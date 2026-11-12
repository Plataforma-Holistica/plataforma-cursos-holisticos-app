import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Offer } from "@/services/billing/checkout";

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

  it("cada tarjeta dice lo mismo que la de /planes para el mismo plan y monto", () => {
    fc.assert(
      fc.property(fc.constantFrom("monthly" as const, "annual" as const), fc.integer({ min: 1, max: 10_000_000 }), (plan, amountCents) => {
        const offer: Offer = { ...OFFER, plans: [{ plan, amountCents, lookupKey: "x", nextChargeAt: "2026-12-10T18:00:00Z" }] };
        const view = plansView(offer, { plan: null, returnTo: null, canceled: false }, PAY, legal);
        if (view.kind !== "ready") return false;
        const card = view.cards[0]!;
        const text = planCardText(plan, amountCents);
        return text.name === card.name && text.price === card.price && text.repeat === card.repeat && text.equivalent === card.equivalent;
      }),
    );
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
