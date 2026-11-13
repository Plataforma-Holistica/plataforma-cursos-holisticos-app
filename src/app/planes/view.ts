import { longDate } from "@/app/_lib/dates";
import { plans as text } from "@/messages/es/plans";
import { t } from "@/messages/format";
import type { CheckoutPlan, Offer } from "@/services/billing/checkout";

import { annualSaving, confirmingHref, monthlyEquivalent, plansHref, priceText, savingText, type PlansQuery } from "./outcomes";

// PA-04 · lo que pinta la pantalla de los planes, armado en el servidor con la oferta de la base y quien mira (T-302). Puro.
//
// Elegir un plan es un enlace (`?plan=`), no un control: así «Antes de pagar» dice el total, la periodicidad, el siguiente cobro y la
// casilla del plan elegido también sin JavaScript, y el formulario lleva exactamente lo que se ve.

/** El bloque «Antes de pagar»: el ancla de los enlaces de elegir y a la que vuelve el formulario sin JavaScript. */
export const PAY_BLOCK_ID = "bloque-pagar";

export interface PlanCard {
  plan: CheckoutPlan;
  name: string;
  price: string;
  repeat: string;
  equivalent: string | null;
  /** El anual que ahorra (T-616, 3b-4): «Conviene más» y su ahorro. Va siempre con `saving`. */
  featured: boolean;
  saving: string | null;
  href: string;
  chooseLabel: string;
  chosen: boolean;
  /** El botón principal: el del destacado, solo sin plan elegido. Elegido uno, la acción principal es pagar. */
  primary: boolean;
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

/** Lo que dice la tarjeta de un plan: el nombre, el total, que lleva IVA y cada cuánto se cobra, y en el anual lo que equivale al mes.
 * Lo comparten `/planes` y la portada, para que las dos digan lo mismo del mismo monto. */
export function planCardText(plan: CheckoutPlan, amountCents: number): { name: string; price: string; repeat: string; equivalent: string | null } {
  return {
    name: plan === "monthly" ? text.monthly : text.annual,
    price: t(plan === "monthly" ? text.perMonth : text.perYear, { price: priceText(amountCents) }),
    repeat: t(text.planNote, { repeat: plan === "monthly" ? text.monthlyRepeat : text.annualRepeat }),
    // Solo de un total que es un entero positivo de centavos: de otro, «Equivale a -$0.00» no diría nada cierto.
    equivalent:
      plan === "annual" && Number.isInteger(amountCents) && amountCents > 0 ? t(text.annualEquivalent, { price: priceText(monthlyEquivalent(amountCents)) }) : null,
  };
}

/**
 * Lo que dicen las tarjetas de una oferta: cada una con su `planCardText`, y el anual destacado con lo que ahorra (T-616, 3b-4). Los planes
 * se buscan por nombre, no por su lugar, y hace falta exactamente uno de cada uno; si no, o si no ahorra, ninguno se destaca. La marca y la
 * cifra van juntas. Lo comparten `/planes` y la portada: para el mismo par, la misma cifra.
 */
export function offerCardsText(
  plans: readonly { plan: CheckoutPlan; amountCents: number }[],
): ({ plan: CheckoutPlan } & ReturnType<typeof planCardText> & { featured: boolean; saving: string | null })[] {
  const monthly = plans.filter((each) => each.plan === "monthly");
  const annual = plans.filter((each) => each.plan === "annual");
  const pesos = monthly.length === 1 && annual.length === 1 ? annualSaving(monthly[0]!.amountCents, annual[0]!.amountCents) : null;
  const saving = pesos === null ? null : t(text.saving, { saving: savingText(pesos) });
  return plans.map(({ plan, amountCents }) => {
    const featured = plan === "annual" && saving !== null;
    return { plan, ...planCardText(plan, amountCents), featured, saving: featured ? saving : null };
  });
}

export interface ShowcaseCard {
  plan: CheckoutPlan;
  name: string;
  price: string;
  repeat: string;
  equivalent: string | null;
  featured: boolean;
  saving: string | null;
  href: string;
  chooseLabel: string;
}

/** Lo que la portada sabe de los precios (T-616, solicitud 4b): lo que contesta la vitrina de `src/services/billing/`, sin nada más. */
export type ShowcaseFacts =
  | { kind: "ready"; plans: readonly { plan: CheckoutPlan; amountCents: number }[]; recurringVersion: number | null }
  | { kind: "unavailable" };

export type ShowcaseView = { kind: "hidden" } | { kind: "unavailable" } | { kind: "ready"; cards: ShowcaseCard[] };

/**
 * La sección de los planes en la portada. A la venta con el mismo criterio que `plansView`: planes, el texto del cobro recurrente y su
 * página; si no, la sección no aparece (decisión de Sergio del 2026-11-12). Si no se supo, va sin cifras. Cada tarjeta lleva a elegir
 * su plan en `/planes`, sin el monto.
 */
export function showcaseView(facts: ShowcaseFacts, legalHref: (doc: "recurring" | "refund", version: number | null) => string | null): ShowcaseView {
  if (facts.kind === "unavailable") return { kind: "unavailable" };
  const recurringHref = facts.recurringVersion === null ? null : legalHref("recurring", facts.recurringVersion);
  if (facts.plans.length === 0 || recurringHref === null) return { kind: "hidden" };
  return {
    kind: "ready",
    // Sin botón principal: en la portada es «Suscribirme» (decisión del carril A del 2026-11-13, sin confirmar por Sergio).
    cards: offerCardsText(facts.plans).map(({ plan, ...card }) => ({
      plan,
      ...card,
      href: `${plansHref(plan, null)}#${PAY_BLOCK_ID}`,
      chooseLabel: t(text.chooseThis, { plan: plan === "monthly" ? text.monthly : text.annual }),
    })),
  };
}

export function plansView(offer: Offer, query: PlansQuery, viewer: PlansViewer, legalHref: (doc: "recurring" | "refund", version: number | null) => string | null): PlansView {
  const recurringHref = offer.recurring === null ? null : legalHref("recurring", offer.recurring.version);
  if (offer.plans.length === 0 || offer.recurring === null || recurringHref === null) return { kind: "not_for_sale" };
  const recurring = offer.recurring;
  const self = plansHref(query.plan, query.returnTo);

  const cards = offerCardsText(offer.plans).map(
    (each): PlanCard => ({
      ...each,
      // Al elegir, la página baja a «Antes de pagar»: en el teléfono quedaría fuera de la vista.
      href: `${plansHref(each.plan, query.returnTo)}#${PAY_BLOCK_ID}`,
      chooseLabel: t(text.chooseThis, { plan: each.plan === "monthly" ? text.monthly : text.annual }),
      chosen: each.plan === query.plan,
      // Destacar no elige: sin `?plan=` no hay «Antes de pagar», y con un plan elegido el principal es pagar. Solo a quien puede pagar
      // (o crear su cuenta para hacerlo): con un pago en confirmación o con acceso, el aviso dice que no vuelva a pagar, y un botón en
      // oro lo contradiría (revisión del carril A sobre de38193). El antetítulo y la cifra se quedan.
      primary: each.featured && query.plan === null && (viewer.kind === "pay" || viewer.kind === "visitor"),
    }),
  );

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
      ? // Sin plan elegido, quien ya tiene cuenta entra directo a donde iba: si no tiene acceso, ahí se le dice (PA-33).
        { kind: "visitor", signUp: viewer.signUp(self), signIn: viewer.signIn(chosen === null ? (query.returnTo ?? self) : self) }
      : viewer.kind === "in_progress"
        ? { kind: "in_progress", href: viewer.session === null ? null : confirmingHref(viewer.session) }
        : viewer;

  return { kind: "ready", self, cards, summary, who, returnTo: query.returnTo, canceled: query.canceled };
}
