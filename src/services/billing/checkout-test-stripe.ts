import type { StripeAnswer, StripeWriteAnswer } from "@/adapters/stripe/api";

import type { CheckoutStripe } from "./checkout";

// Stripe de prueba para la salida a pagar, solo en local (el pago de prueba de `env.ts`, que no se admite fuera de local): no llama a nadie. Lo usa el extremo a
// extremo, que no habla con Stripe. Contesta lo mismo que Stripe a lo que pide el servicio, y siempre lo mismo para la misma llave de idempotencia:
//   · el precio de una `lookup_key` es el que dice la clave (`plataforma_<plan>_<centavos>_mxn`), con el IVA incluido;
//   · el cliente no tiene saldo ni suscripciones;
//   · la sesión creada se llama como su salida, y leída está completa, con una suscripción que se llama igual (`sub_local…`): la página de pago de prueba
//     (`/suscripcion/prueba`) solo lleva a PA-32. El aviso que da el acceso lo escribe la prueba en la base, como en el resto del extremo a extremo.

const ok = (body: unknown): StripeAnswer & StripeWriteAnswer => ({ status: "ok", body });
/** El identificador de la llave de idempotencia (`verbo:<uuid>[:modo]`), sin guiones. */
const hexOf = (key: string) => (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(key)?.[0] ?? "0").replaceAll("-", "");

export function testCheckoutStripe(): CheckoutStripe {
  return {
    live: false,
    test: true,
    get: async (path, query = {}) => {
      if (path === "/v1/prices") {
        const keys = query["lookup_keys[]"];
        const key = typeof keys === "string" ? keys : keys?.[0];
        const match = key === undefined ? null : /^plataforma_(monthly|annual)_([1-9][0-9]*)_mxn$/.exec(key);
        if (match === null) return ok({ data: [] });
        const [, plan, amount] = match;
        return ok({
          data: [
            {
              id: `price_test_${plan}_${amount}`,
              lookup_key: key,
              active: true,
              currency: "mxn",
              unit_amount: Number(amount),
              tax_behavior: "inclusive",
              livemode: false,
              recurring: { interval: plan === "monthly" ? "month" : "year", interval_count: 1 },
              // Expandido, como lo pide el servicio: trae también la moneda base.
              currency_options: { mxn: { unit_amount: Number(amount), tax_behavior: "inclusive" } },
            },
          ],
        });
      }
      const customer = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)$/.exec(path);
      if (customer) return ok({ id: customer[1], balance: 0 });
      if (path === "/v1/subscriptions") return ok({ data: [], has_more: false });
      const session = /^\/v1\/checkout\/sessions\/cs_test_local([0-9a-f]+)$/.exec(path);
      if (session) return ok({ id: `cs_test_local${session[1]}`, status: "complete", subscription: `sub_local${session[1]}` });
      return { status: "not_found" };
    },
    post: async (path, _form, idempotencyKey) => {
      if (path === "/v1/customers") return ok({ id: `cus_local${hexOf(idempotencyKey)}` });
      if (path === "/v1/checkout/sessions") {
        const id = `cs_test_local${hexOf(idempotencyKey)}`;
        return ok({ id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open" });
      }
      if (/^\/v1\/checkout\/sessions\/cs_test_local[0-9a-f]+\/expire$/.test(path)) return ok({ status: "expired" });
      return { status: "rejected" };
    },
  };
}
