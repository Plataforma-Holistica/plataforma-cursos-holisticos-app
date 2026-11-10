import { z } from "zod";

import type { StripeAnswer, StripeGet, StripePost } from "@/adapters/stripe/api";
import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { resolveAccountAccess, type AccountFacts } from "@/domain/access/account-access";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

// La salida a pagar (T-302, segunda solicitud; RF-201, RF-202; plan aprobado por Sergio el 2026-11-09). PA-04 lee la oferta; «Continuar al pago» reserva la salida en
// la base (con el consentimiento del cobro recurrente), le pregunta a Stripe lo que la base no puede saber y crea la sesión de pago; PA-32 lee cómo va. El acceso
// nunca sale de aquí: sale del aviso de Stripe (`billing_apply`, T-303).
//
// Lo que cuida, en este orden, para no cobrarle dos veces a nadie:
//   · quien ya tiene acceso no sale a pagar (la regla única), y la base no reserva con un pago en curso;
//   · antes de crear, Stripe dice si el cliente ya tiene una suscripción viva o sin terminar, que la base no conoce si su aviso no llegó; si no se pudo leer, no se crea;
//   · el precio por su `lookup_key`, que debe cuadrar con lo que se mostró (el parámetro), sin otras monedas;
//   · el cliente, sin saldo a favor (la primera factura saldría en cero y quedaría fallida);
//   · crear manda exactamente lo reservado, con la llave de idempotencia de la salida: si no se supo, se reintenta igual, y Stripe devuelve la que ya hizo;
//   · solo se abandona lo que nunca se pidió a Stripe o lo que Stripe rechazó crear; una abierta de otro plan se vence en Stripe antes de abrir otra.

export type CheckoutPlan = "monthly" | "annual";
export const CHECKOUT_PLANS = ["monthly", "annual"] as const;

export interface OfferPlan {
  plan: CheckoutPlan;
  amountCents: number;
  lookupKey: string;
  nextChargeAt: string;
}

export interface Offer {
  plans: OfferPlan[];
  recurring: { id: string; version: number; title: string; body: string } | null;
  refundPolicy: string | null;
  refundDays: number | null;
}

export type CheckoutState = "reserved" | "creating" | "open" | "completed" | "expired" | "abandoned" | "lapsed";

export interface CheckoutRow {
  id: string;
  plan: CheckoutPlan;
  livemode: boolean;
  lookupKey: string;
  amountCents: number;
  nextChargeAt: string;
  expiresAt: string;
  returnTo: string;
  state: CheckoutState;
  sessionId: string | null;
  url: string | null;
}

export type BeginAnswer =
  | { answer: "not_allowed"; reason: "no_actor" | "suspended" | "email_unverified" }
  | { answer: "invalid" | "in_progress" | "unavailable" | "changed" }
  | { answer: "reuse" | "open_other" | "reserved"; checkout: CheckoutRow; customer: string | null };

export interface StartInput {
  plan: CheckoutPlan;
  amountSeen: number;
  documentSeen: string;
  returnTo: string;
  ip: string | null;
  userAgent: string | null;
}

export interface BeginInput extends StartInput {
  livemode: boolean;
}

export type CreatingAnswer = { answer: "creating" | "open"; checkout: CheckoutRow } | { answer: "closed" | "stale" | "not_found" | "not_allowed" };
export type RecordAnswer = "recorded" | "conflict" | "invalid" | "not_found" | "not_allowed";
export type CloseAnswer = "closed" | "already_closed" | "not_allowed" | "invalid" | "not_found";
export type StatusRow =
  | { mine: false }
  | { mine: true; id: string; state: CheckoutState; returnTo: string; subscriptionId: string | null; live: boolean };

export interface AccountRead {
  now: Date;
  email: string | null;
  account: AccountFacts;
  graceDays: number;
}

export interface CheckoutStore {
  offer(): Promise<Offer>;
  accountFacts(claims: VerifiedClaims): Promise<AccountRead | null>;
  standing(claims: VerifiedClaims): Promise<{ blocking: boolean; open: CheckoutRow | null } | null>;
  begin(claims: VerifiedClaims, input: BeginInput): Promise<BeginAnswer>;
  creating(claims: VerifiedClaims, checkout: string): Promise<CreatingAnswer>;
  customerRecord(claims: VerifiedClaims, livemode: boolean, customer: string): Promise<RecordAnswer>;
  sessionRecord(claims: VerifiedClaims, checkout: string, session: string, url: string): Promise<RecordAnswer>;
  close(claims: VerifiedClaims, checkout: string, state: "abandoned" | "expired" | "completed", subscription: string | null): Promise<CloseAnswer>;
  status(claims: VerifiedClaims, session: string): Promise<StatusRow>;
}

/**
 * Stripe para la salida a pagar: leer y escribir, con la llave de la salida. `live`: la llave es del modo real. `test`: la página de pago de prueba de local, que hace
 * de la de Stripe.
 */
export interface CheckoutStripe {
  get: StripeGet;
  post: StripePost;
  live: boolean;
  test: boolean;
}

export interface CheckoutDeps {
  store: CheckoutStore;
  stripe: () => CheckoutStripe | null;
  checkSession(reader: CookieReader): Promise<SessionCheck>;
  /** La dirección configurada del sitio, nunca la de la petición: a ella vuelve Stripe. */
  siteUrl: () => string;
  report(code: FailureCode): Promise<void>;
  now(): Date;
}

export type StartAnswer =
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "redirect"; url: string }
  | { kind: "has_access" }
  | { kind: "in_progress" }
  | { kind: "changed" }
  | { kind: "invalid" }
  | { kind: "not_allowed"; reason: "no_actor" | "suspended" | "email_unverified" }
  | { kind: "unavailable" };

export type Progress = { kind: "not_found" } | { kind: "live"; returnTo: string } | { kind: "waiting"; returnTo: string } | { kind: "expired" } | { kind: "unavailable" };

export type PlanStanding = { kind: "ready"; access: boolean; blocking: boolean; open: CheckoutRow | null } | { kind: "unavailable" };

/** Una sesión de pago de Stripe, por su forma. */
export const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,250}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,250}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,250}$/;
const STRIPE_URL = /^https:\/\/checkout\.stripe\.com\//;
/** Lo que en Stripe es un pago en curso: una suscripción viva o que todavía puede cobrarse. */
const LIVE_IN_STRIPE = new Set(["active", "trialing", "past_due", "incomplete", "unpaid", "paused"]);
/** Una abierta se reusa si le queda por lo menos esto: si no, la persona llegaría a una página vencida. */
const REUSE_MARGIN_MS = 2 * 60_000;
/** Intentos de reservar en una petición: una salida vieja o de otro plan se cierra y se reserva otra. */
const ROUNDS = 3;

export const CHECKOUT_SUBMIT_TEXT =
  "El precio es el total, IVA incluido. Se cobra hoy y se repite cada periodo de tu plan hasta que canceles; puedes cancelar cuando quieras desde tu cuenta.";

const priceList = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        lookup_key: z.string().nullable(),
        active: z.boolean(),
        currency: z.string(),
        unit_amount: z.number().nullable(),
        tax_behavior: z.string().nullable(),
        livemode: z.boolean(),
        recurring: z.object({ interval: z.string(), interval_count: z.number() }).nullable(),
        currency_options: z.unknown().optional(),
      })
      .passthrough(),
  ),
});
const customerRead = z.object({ id: z.string(), balance: z.number().optional(), deleted: z.boolean().optional() }).passthrough();
const subscriptionList = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) });
const sessionRead = z.object({ id: z.string(), status: z.string().nullable(), subscription: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullable() }).passthrough();
const sessionCreated = z.object({ id: z.string().regex(SESSION_ID), url: z.string().regex(STRIPE_URL) }).passthrough();
const customerCreated = z.object({ id: z.string().regex(CUSTOMER_ID) }).passthrough();

function bodyOf<T>(answer: StripeAnswer | { status: string; body?: unknown }, schema: z.ZodType<T>): T | null {
  if (answer.status !== "ok") return null;
  const parsed = schema.safeParse((answer as { body: unknown }).body);
  return parsed.success ? parsed.data : null;
}

const subscriptionIdOf = (value: string | { id: string } | null): string | null => {
  const id = value === null ? null : typeof value === "string" ? value : value.id;
  return id !== null && SUBSCRIPTION_ID.test(id) ? id : null;
};

export function createCheckout(deps: CheckoutDeps) {
  /** Lo que PA-04 muestra, también al visitante. */
  async function planOffer(): Promise<{ kind: "ready"; offer: Offer } | { kind: "unavailable" }> {
    try {
      return { kind: "ready", offer: await deps.store.offer() };
    } catch {
      await deps.report("checkout_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** Lo que PA-04 sabe de quien mira: si ya tiene acceso, si tiene un pago en curso y su salida abierta. */
  async function planStanding(claims: VerifiedClaims): Promise<PlanStanding> {
    try {
      const [facts, standing] = await Promise.all([deps.store.accountFacts(claims), deps.store.standing(claims)]);
      if (facts === null || standing === null) return { kind: "unavailable" };
      return { kind: "ready", access: hasAccess(facts), blocking: standing.blocking, open: standing.open };
    } catch {
      await deps.report("checkout_unavailable");
      return { kind: "unavailable" };
    }
  }

  function hasAccess(facts: AccountRead): boolean {
    return resolveAccountAccess(facts.account, facts.now, { graceDays: facts.graceDays }).allowed;
  }

  /** «Continuar al pago». Corre la guarda, y solo con una sesión que pasa habla con la base y con Stripe. */
  async function startCheckout(reader: CookieReader, input: StartInput): Promise<StartAnswer> {
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    const stripe = deps.stripe();
    if (stripe === null) {
      await deps.report("checkout_no_key");
      return { kind: "unavailable" };
    }
    try {
      return await start(check.claims, input, stripe);
    } catch {
      await deps.report("checkout_unavailable");
      return { kind: "unavailable" };
    }
  }

  async function start(claims: VerifiedClaims, input: StartInput, stripe: CheckoutStripe): Promise<StartAnswer> {
    const facts = await deps.store.accountFacts(claims);
    if (facts === null) return { kind: "unavailable" };
    if (hasAccess(facts)) return { kind: "has_access" };
    const livemode = stripe.live;
    for (let round = 0; round < ROUNDS; round += 1) {
      const begun = await deps.store.begin(claims, { ...input, livemode });
      switch (begun.answer) {
        case "not_allowed":
          return { kind: "not_allowed", reason: begun.reason };
        case "invalid":
        case "in_progress":
        case "unavailable":
        case "changed":
          return { kind: begun.answer };
        case "open_other": {
          const retired = await retire(claims, begun.checkout, begun.customer, facts.email, stripe);
          if (retired === "paid") return { kind: "in_progress" };
          if (retired === "unknown") return { kind: "unavailable" };
          continue;
        }
        case "reuse":
        case "reserved": {
          const proceeded = await proceed(claims, begun.checkout, begun.customer, facts.email, stripe);
          if (proceeded === "again") continue;
          return proceeded;
        }
      }
    }
    return { kind: "unavailable" };
  }

  /** Lo que se hace con la salida reservada o reusada: su dirección, o todo lo que falta para crearla. */
  async function proceed(
    claims: VerifiedClaims,
    row: CheckoutRow,
    knownCustomer: string | null,
    email: string | null,
    stripe: CheckoutStripe,
  ): Promise<StartAnswer | "again"> {
    if (row.state === "open" && row.url !== null && row.sessionId !== null) {
      if (Date.parse(row.expiresAt) - deps.now().getTime() > REUSE_MARGIN_MS) return { kind: "redirect", url: urlFor(stripe, row.sessionId, row.url) };
      const retired = await retire(claims, row, knownCustomer, email, stripe);
      if (retired === "paid") return { kind: "in_progress" };
      return retired === "unknown" ? { kind: "unavailable" } : "again";
    }
    const abandon = async (code: FailureCode | null): Promise<void> => {
      if (code !== null) await deps.report(code);
      if (row.state === "reserved") await deps.store.close(claims, row.id, "abandoned", null);
    };

    const customer = knownCustomer ?? (await createCustomer(claims, row, email, stripe));
    if (customer === "conflict") {
      await abandon("checkout_customer_conflict");
      return { kind: "unavailable" };
    }
    if (customer === null) return { kind: "unavailable" };

    const read = bodyOf(await stripe.get(`/v1/customers/${customer}`), customerRead);
    if (read === null) return { kind: "unavailable" };
    if (read.deleted === true || (read.balance ?? 0) !== 0) {
      await abandon("checkout_customer_balance");
      return { kind: "unavailable" };
    }

    const subscriptions = bodyOf(await stripe.get("/v1/subscriptions", { customer, status: "all", limit: "20" }), subscriptionList);
    if (subscriptions === null) return { kind: "unavailable" };
    if (subscriptions.data.some((each) => LIVE_IN_STRIPE.has(each.status))) {
      await abandon(null);
      return { kind: "in_progress" };
    }

    const price = await priceFor(row, stripe);
    if (price === "unavailable") return { kind: "unavailable" };
    if (price === "mismatch") {
      await abandon("checkout_price_mismatch");
      return { kind: "unavailable" };
    }

    const creating = await deps.store.creating(claims, row.id);
    if (creating.answer === "stale") {
      await deps.store.close(claims, row.id, "abandoned", null);
      return "again";
    }
    if (creating.answer === "open") {
      const open = creating.checkout;
      return open.sessionId !== null && open.url !== null ? { kind: "redirect", url: urlFor(stripe, open.sessionId, open.url) } : { kind: "unavailable" };
    }
    if (creating.answer !== "creating") return "again";
    return create(claims, creating.checkout, customer, price, stripe);
  }

  /** El cliente nuevo de Stripe, con su llave por cuenta y modo: un corte entre crearlo y anotarlo no crea un segundo. */
  async function createCustomer(claims: VerifiedClaims, row: CheckoutRow, email: string | null, stripe: CheckoutStripe): Promise<string | "conflict" | null> {
    const form: Record<string, string> = { "metadata[profile_id]": claims.userId };
    if (email !== null) form.email = email;
    const created = bodyOf(await stripe.post("/v1/customers", form, `customer:${claims.userId}:${row.livemode ? "live" : "test"}`), customerCreated);
    if (created === null) return null;
    const recorded = await deps.store.customerRecord(claims, row.livemode, created.id);
    return recorded === "recorded" ? created.id : "conflict";
  }

  /** El precio de la salida por su `lookup_key`: uno solo, que cuadre con lo que se mostró. */
  async function priceFor(row: CheckoutRow, stripe: CheckoutStripe): Promise<string | "mismatch" | "unavailable"> {
    const list = bodyOf(await stripe.get("/v1/prices", { "lookup_keys[]": [row.lookupKey], limit: "10" }), priceList);
    if (list === null) return "unavailable";
    const [price, ...more] = list.data;
    const interval = row.plan === "monthly" ? "month" : "year";
    const fits =
      price !== undefined &&
      more.length === 0 &&
      price.lookup_key === row.lookupKey &&
      price.active &&
      price.currency === "mxn" &&
      price.unit_amount === row.amountCents &&
      price.tax_behavior === "inclusive" &&
      price.livemode === row.livemode &&
      price.recurring?.interval === interval &&
      price.recurring.interval_count === 1 &&
      price.currency_options === undefined;
    return fits ? price.id : "mismatch";
  }

  /** Crea la sesión con exactamente lo reservado, y la anota. */
  async function create(claims: VerifiedClaims, row: CheckoutRow, customer: string, price: string, stripe: CheckoutStripe): Promise<StartAnswer> {
    const site = deps.siteUrl();
    const form: Record<string, string> = {
      mode: "subscription",
      customer,
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      client_reference_id: row.id,
      "metadata[profile_id]": claims.userId,
      "metadata[checkout_id]": row.id,
      "subscription_data[metadata][profile_id]": claims.userId,
      "subscription_data[metadata][checkout_id]": row.id,
      success_url: `${site}/suscripcion/confirmando?sesion={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/planes?cancelado=1`,
      expires_at: String(Math.floor(Date.parse(row.expiresAt) / 1000)),
      locale: "es-419",
      "allowed_payment_method_types[0]": "card",
      "adaptive_pricing[enabled]": "false",
      "custom_text[submit][message]": CHECKOUT_SUBMIT_TEXT,
    };
    const answer = await stripe.post("/v1/checkout/sessions", form, `checkout:${row.id}`);
    if (answer.status === "rejected") {
      await deps.store.close(claims, row.id, "abandoned", null);
      await deps.report("checkout_create_rejected");
      return { kind: "unavailable" };
    }
    if (answer.status === "unauthorized") await deps.report("checkout_key_rejected");
    const session = bodyOf(answer, sessionCreated);
    if (session === null) return { kind: "unavailable" };
    const recorded = await deps.store.sessionRecord(claims, row.id, session.id, session.url);
    if (recorded !== "recorded") {
      await deps.report("checkout_session_unrecorded");
      return { kind: "unavailable" };
    }
    return { kind: "redirect", url: urlFor(stripe, session.id, session.url) };
  }

  /**
   * Cierra una salida abierta antes de abrir otra. Lo reservado, que Stripe no conoce, se abandona; lo abierto se vence en Stripe, y si Stripe ya no la vence porque
   * se pagó, es un pago en curso (`paid`). `unknown`: no se supo, y no se abre otra.
   */
  async function retire(
    claims: VerifiedClaims,
    row: CheckoutRow,
    customer: string | null,
    email: string | null,
    stripe: CheckoutStripe,
  ): Promise<"done" | "paid" | "unknown"> {
    if (row.state === "reserved") {
      await deps.store.close(claims, row.id, "abandoned", null);
      return "done";
    }
    let sessionId = row.sessionId;
    if (row.state === "creating" && sessionId === null) {
      // Pudo haberse creado: se manda otra vez lo mismo, y Stripe devuelve la que hizo (o la crea), para poder vencerla.
      const resumed = await proceed(claims, row, customer, email, stripe);
      if (resumed === "again" || resumed.kind !== "redirect") return "unknown";
      sessionId = sessionFromUrl(resumed.url);
    }
    if (sessionId === null) return "unknown";
    const expired = await stripe.post(`/v1/checkout/sessions/${sessionId}/expire`, {}, `expire:${row.id}`);
    if (expired.status === "ok") {
      await deps.store.close(claims, row.id, "expired", null);
      return "done";
    }
    if (expired.status === "unknown" || expired.status === "unauthorized") return "unknown";
    // Stripe no la venció: ya estaba vencida o completada. Se le pregunta.
    const read = bodyOf(await stripe.get(`/v1/checkout/sessions/${sessionId}`), sessionRead);
    if (read === null) return "unknown";
    if (read.status === "complete") {
      const subscription = subscriptionIdOf(read.subscription);
      if (subscription === null) return "unknown";
      await deps.store.close(claims, row.id, "completed", subscription);
      return "paid";
    }
    if (read.status === "expired") {
      await deps.store.close(claims, row.id, "expired", null);
      return "done";
    }
    return "unknown";
  }

  /** PA-32: cómo va el pago de la sesión `session`, que debe ser de quien mira. Nunca da acceso. */
  async function checkoutProgress(claims: VerifiedClaims, session: string): Promise<Progress> {
    if (!SESSION_ID.test(session)) return { kind: "not_found" };
    try {
      return await progressOf(claims, session);
    } catch {
      await deps.report("checkout_unavailable");
      return { kind: "unavailable" };
    }
  }

  async function progressOf(claims: VerifiedClaims, session: string): Promise<Progress> {
    let status = await deps.store.status(claims, session);
    if (!status.mine) return { kind: "not_found" };
    if (status.live) return { kind: "live", returnTo: status.returnTo };
    if ((status.state === "open" || status.state === "creating" || status.state === "lapsed") && status.subscriptionId === null) {
      const stripe = deps.stripe();
      const read = stripe === null ? null : bodyOf(await stripe.get(`/v1/checkout/sessions/${session}`), sessionRead);
      if (read !== null && read.status === "complete") {
        const subscription = subscriptionIdOf(read.subscription);
        if (subscription !== null) {
          await deps.store.close(claims, status.id, "completed", subscription);
          status = await deps.store.status(claims, session);
        }
      } else if (read !== null && read.status === "expired") {
        await deps.store.close(claims, status.id, "expired", null);
        status = await deps.store.status(claims, session);
      }
      if (!status.mine) return { kind: "not_found" };
    }
    if (status.live) return { kind: "live", returnTo: status.returnTo };
    if (status.state === "expired" || status.state === "abandoned" || (status.state === "lapsed" && status.subscriptionId === null)) return { kind: "expired" };
    return { kind: "waiting", returnTo: status.returnTo };
  }

  return { planOffer, planStanding, startCheckout, checkoutProgress };
}

/** A dónde va el navegador: la página de Stripe, o en local la de prueba, que hace de ella. */
function urlFor(stripe: CheckoutStripe, session: string, url: string): string {
  return stripe.test ? `/suscripcion/prueba?sesion=${session}` : url;
}

function sessionFromUrl(url: string): string | null {
  const match = /(cs_(test|live)_[A-Za-z0-9]{1,250})/.exec(url);
  return match ? match[1]! : null;
}
