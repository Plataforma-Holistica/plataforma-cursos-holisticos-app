import { longDate } from "@/app/_lib/dates";
import { plans as text } from "@/messages/es/plans";
import { t } from "@/messages/format";
import type { CheckoutPlan, Offer } from "@/services/billing/checkout";

import { confirmingHref, monthlyEquivalent, plansHref, priceText, type PlansQuery } from "./outcomes";

// PA-04 · lo que pinta la pantalla de los planes, armado en el servidor con la oferta de la base y quien mira (T-302). Puro.
//
// Elegir un plan es un enlace (`?plan=`), no un control: así «Antes de pagar» dice el total, la periodicidad, el siguiente cobro y la
// casilla del plan elegido también sin JavaScript, y el formulario lleva exactamente lo que se ve.

export interface PlanCard {
  plan: CheckoutPlan;
  name: string;
  price: string;
  repeat: string;
  equivalent: string | null;
  href: string;
  chooseLabel: string;
  chosen: boolean;
}

export interface PlanSummary {
  plan: CheckoutPlan;
  price: string;
  repeats: string;
  nextCharge: string;
  consent: string;
  consentHref: string;
  refund: string | null;
  refundHref: string | null;
  draft: boolean;
  /** Lo que lleva el formulario: el monto y el texto que se vieron. */
  amount: number;
  document: string;
}

/** Quien mira y lo que puede hacer. */
export type PlansWho =
  | { kind: "pay" }
  | { kind: "visitor"; signUp: string; signIn: string }
  | { kind: "has_access" }
  | { kind: "in_progress"; href: string | null };

export type PlansView =
  | { kind: "not_for_sale" }
  | { kind: "ready"; self: string; cards: PlanCard[]; summary: PlanSummary | null; who: PlansWho; returnTo: string | null; canceled: boolean };

export type PlansViewer =
  | { kind: "visitor"; signUp: (target: string) => string; signIn: (target: string) => string }
  | { kind: "pay" }
  | { kind: "has_access" }
  | { kind: "in_progress"; session: string | null };

export function plansView(offer: Offer, query: PlansQuery, viewer: PlansViewer, legalHref: (doc: "recurring" | "refund", version: number | null) => string | null): PlansView {
  const recurringHref = offer.recurring === null ? null : legalHref("recurring", offer.recurring.version);
  if (offer.plans.length === 0 || offer.recurring === null || recurringHref === null) return { kind: "not_for_sale" };
  const recurring = offer.recurring;
  const self = plansHref(query.plan, query.returnTo);

  const cards = offer.plans.map((each): PlanCard => ({
    plan: each.plan,
    name: each.plan === "monthly" ? text.monthly : text.annual,
    price: t(each.plan === "monthly" ? text.perMonth : text.perYear, { price: priceText(each.amountCents) }),
    repeat: t(text.planNote, { repeat: each.plan === "monthly" ? text.monthlyRepeat : text.annualRepeat }),
    equivalent: each.plan === "annual" ? t(text.annualEquivalent, { price: priceText(monthlyEquivalent(each.amountCents)) }) : null,
    href: plansHref(each.plan, query.returnTo),
    chooseLabel: t(text.chooseThis, { plan: each.plan === "monthly" ? text.monthly : text.annual }),
    chosen: each.plan === query.plan,
  }));

  const chosen = offer.plans.find((each) => each.plan === query.plan) ?? null;
  const refundHref = offer.refundPolicy === null ? null : legalHref("refund", null);
  const summary: PlanSummary | null =
    chosen === null
      ? null
      : {
          plan: chosen.plan,
          price: t(text.totalLine, { price: priceText(chosen.amountCents) }),
          repeats: chosen.plan === "monthly" ? text.everyMonth : text.everyYear,
          nextCharge: t(text.nextChargeLine, { date: longDate(chosen.nextChargeAt), price: priceText(chosen.amountCents) }),
          consent: chosen.plan === "monthly" ? text.consentMonthly : text.consentAnnual,
          consentHref: recurringHref,
          refund: offer.refundDays === null ? null : t(text.refund, { days: offer.refundDays }),
          refundHref,
          draft: recurring.version === 0,
          amount: chosen.amountCents,
          document: recurring.id,
        };

  const who: PlansWho =
    viewer.kind === "visitor"
      ? { kind: "visitor", signUp: viewer.signUp(self), signIn: viewer.signIn(self) }
      : viewer.kind === "in_progress"
        ? { kind: "in_progress", href: viewer.session === null ? null : confirmingHref(viewer.session) }
        : viewer;

  return { kind: "ready", self, cards, summary, who, returnTo: query.returnTo, canceled: query.canceled };
}
