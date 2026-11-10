import { describe, expect, it } from "vitest";

import type { Offer } from "@/services/billing/checkout";

import { plansView, type PlansViewer } from "./view";

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
    expect(view.cards[1]?.equivalent).toBe("Equivale a $290.83 al mes.");
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
