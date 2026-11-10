import "server-only";

import { createStripeApi, createStripeWriter } from "@/adapters/stripe/api";
import { asServer, asSystem } from "@/adapters/supabase/db";
import { getEnv } from "@/config/env";
import { checkSession } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";
import { readAccountFacts } from "@/services/media/records";

import { createCheckout, type CheckoutStore, type CheckoutStripe } from "./checkout";
import { askBegin, askClose, askCreating, askCustomerRecord, askOffer, askSessionRecord, askStanding, askStatus } from "./checkout-records";
import { testCheckoutStripe } from "./checkout-test-stripe";

// La salida a pagar ya armada (T-302): lo que importan PA-04 y PA-32. Con `STRIPE_CHECKOUT_KEY` habla con Stripe; con `BILLING_CHECKOUT=test` (solo local), con el
// Stripe de prueba; sin ninguna, no se sale a pagar. La base, como la persona por el servidor; la oferta, como sistema.

export const databaseCheckoutStore: CheckoutStore = {
  offer: () => asSystem({ reason: "checkout_offer" }, askOffer),
  accountFacts: (claims) => asServer({ claims, reason: "checkout_facts" }, readAccountFacts),
  standing: (claims) => asServer({ claims, reason: "checkout_standing" }, askStanding),
  begin: (claims, input) => asServer({ claims, reason: "checkout_begin" }, (tx) => askBegin(tx, input)),
  creating: (claims, checkout) => asServer({ claims, reason: "checkout_creating" }, (tx) => askCreating(tx, checkout)),
  customerRecord: (claims, livemode, customer) => asServer({ claims, reason: "checkout_customer" }, (tx) => askCustomerRecord(tx, livemode, customer)),
  sessionRecord: (claims, checkout, session, url) => asServer({ claims, reason: "checkout_session" }, (tx) => askSessionRecord(tx, checkout, session, url)),
  close: (claims, checkout, state, subscription) => asServer({ claims, reason: "checkout_close" }, (tx) => askClose(tx, checkout, state, subscription)),
  status: (claims, session) => asServer({ claims, reason: "checkout_status" }, (tx) => askStatus(tx, session)),
};

/** Si la salida a pagar va con la página de pago de prueba de local. */
export const checkoutTestMode = (): boolean => getEnv().BILLING_CHECKOUT === "test";

function stripe(): CheckoutStripe | null {
  if (checkoutTestMode()) return testCheckoutStripe();
  const key = getEnv().STRIPE_CHECKOUT_KEY;
  if (key === undefined) return null;
  return { get: createStripeApi({ secretKey: key }), post: createStripeWriter({ secretKey: key }), live: /^(sk|rk)_live_/.test(key), test: false };
}

export const { planOffer, planStanding, startCheckout, checkoutProgress } = createCheckout({
  store: databaseCheckoutStore,
  stripe,
  checkSession,
  siteUrl: () => getEnv().NEXT_PUBLIC_SITE_URL.replace(/\/+$/, ""),
  report: reportFailure,
  now: () => new Date(),
});

export type { CheckoutPlan, CheckoutRow, Offer, OfferPlan, PlanStanding, Progress, StartAnswer, StartInput } from "./checkout";
export { CHECKOUT_PLANS, SESSION_ID } from "./checkout";
