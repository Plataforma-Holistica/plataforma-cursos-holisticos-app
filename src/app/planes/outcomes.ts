import { ROUTES } from "@/services/account/navigation";
import type { CheckoutPlan, StartAnswer } from "@/services/billing/checkout";

// PA-04 · lo que llega del formulario y lo que se hace con cada respuesta de la salida a pagar (T-302). Puro: viaja al navegador.

export const PLAN_FIELD = "plan";
export const AMOUNT_FIELD = "monto";
export const DOCUMENT_FIELD = "texto";
export const RETURN_FIELD = "volver";
export const ACCEPT_FIELD = "acepto";

const PLANS: readonly CheckoutPlan[] = ["monthly", "annual"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PlansProblem = "choose_plan" | "must_accept";
export type PlansAnswer = "changed" | "in_progress" | "has_access" | "unavailable" | "email_unverified" | "suspended" | "invalid";

export type PlansState =
  | { kind: "idle" }
  | { kind: "problem"; problem: PlansProblem; plan: CheckoutPlan | null; attempt: number }
  | { kind: "answer"; answer: PlansAnswer; plan: CheckoutPlan | null; attempt: number };

export interface PlansRequest {
  plan: CheckoutPlan | null;
  amount: number | null;
  document: string | null;
  returnTo: string | null;
  accepted: boolean;
}

/** Un campo con un solo valor de texto; si falta, se repite o no es texto, nulo. */
function only(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  const [value] = values;
  return values.length === 1 && typeof value === "string" ? value : null;
}

export function readPlansForm(form: unknown): PlansRequest | null {
  if (!(form instanceof FormData)) return null;
  const plan = only(form, PLAN_FIELD);
  const amount = only(form, AMOUNT_FIELD);
  const document = only(form, DOCUMENT_FIELD);
  return {
    plan: PLANS.find((each) => each === plan) ?? null,
    amount: amount !== null && /^[1-9][0-9]{0,11}$/.test(amount) ? Number(amount) : null,
    document: document !== null && UUID.test(document) ? document : null,
    returnTo: only(form, RETURN_FIELD),
    // La casilla vale solo con su valor: lo que manda `ConsentCheckbox`.
    accepted: only(form, ACCEPT_FIELD) === "on",
  };
}

/** Lo que pinta la pantalla después de una respuesta que no sale de ella. */
export function plansAnswerOf(answer: Exclude<StartAnswer, { kind: "redirect" } | { kind: "session" }>): PlansAnswer {
  switch (answer.kind) {
    case "not_allowed":
      return answer.reason === "email_unverified" ? "email_unverified" : answer.reason === "suspended" ? "suspended" : "unavailable";
    case "has_access":
    case "in_progress":
    case "changed":
    case "unavailable":
    case "invalid":
      return answer.kind;
  }
}

/** El precio al mes del plan anual, «equivale a», redondeado hacia arriba al centavo: nunca se anuncia menos de lo que cuesta
 * (decisión de Sergio del 2026-11-12; antes era hacia abajo). */
export function monthlyEquivalent(annualCents: number): number {
  return Math.ceil(annualCents / 12);
}

const MONEY = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

/** «$349.00»: el total, con el IVA dentro. */
export function priceText(cents: number): string {
  return MONEY.format(cents / 100);
}

export interface PlansQuery {
  /** El plan elegido en la dirección (`?plan=`), o nulo: los dos se muestran sin elegir. */
  plan: CheckoutPlan | null;
  /** A dónde volver después de pagar, ya validado; nulo si no hay o no vale. */
  returnTo: string | null;
  /** Se volvió de Stripe sin pagar (`?cancelado=1`). */
  canceled: boolean;
}

type Search = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined): string | null => (typeof value === "string" ? value : null);

/** Lo que PA-04 lee de su dirección. El destino lo valida quien llama (`resolveReturn`), con la lista de destinos. */
export function readPlansQuery(search: Search, resolveReturn: (input: string) => string | null): PlansQuery {
  const plan = single(search.plan);
  const back = single(search.volver);
  const resolved = back === null ? null : resolveReturn(back);
  // Los planes no son destino de sí mismos: «Continuar» llevaría a la misma pantalla.
  const own = resolved !== null && (resolved === ROUTES.plans || resolved.startsWith(`${ROUTES.plans}?`) || resolved.startsWith(`${ROUTES.plans}/`));
  return {
    plan: PLANS.find((each) => each === plan) ?? null,
    returnTo: own ? null : resolved,
    canceled: single(search.cancelado) === "1",
  };
}

/**
 * Si los planes no se venden todavía, a dónde quería ir el visitante que llegó de otra
 * pantalla: se le manda a entrar con ese destino, que es lo que sirve a quien ya tiene cuenta. Nulo: se queda y se le dice.
 */
export function closedPlansDetour(who: "visitor" | "student" | "unknown", returnTo: string | null): string | null {
  return who === "visitor" ? returnTo : null;
}

/** PA-04 con un plan elegido y el destino, para los enlaces de elegir y para volver después de crear la cuenta o entrar. */
export function plansHref(plan: CheckoutPlan | null, returnTo: string | null): string {
  const query = new URLSearchParams();
  if (plan !== null) query.set("plan", plan);
  if (returnTo !== null) query.set("volver", returnTo);
  const rest = query.toString();
  return rest === "" ? ROUTES.plans : `${ROUTES.plans}?${rest}`;
}

/** PA-32 de una sesión de pago. */
export function confirmingHref(session: string): string {
  return `${ROUTES.checkoutConfirming}?sesion=${encodeURIComponent(session)}`;
}
