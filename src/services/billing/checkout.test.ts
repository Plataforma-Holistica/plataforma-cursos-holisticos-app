import { describe, expect, it, vi } from "vitest";

import type { StripeAnswer, StripeWriteAnswer } from "@/adapters/stripe/api";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { SessionCheck } from "@/services/account/admission";

import { createCheckout, type BeginAnswer, type CheckoutRow, type CheckoutStore, type StartInput } from "./checkout";

// La salida a pagar (T-302, segunda solicitud), con la base y Stripe simulados: qué le pregunta a cada uno, en qué orden, y qué contesta. Lo que la base hace de
// verdad lo prueban `88_salida_a_pagar` y la integración 117; aquí, que el servicio nunca abra una sesión cobrable de más ni pierda una que ya existe.

const CLAIMS = { userId: "a1000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 } as unknown as VerifiedClaims;
const READER = {} as CookieReader;
const NOW = new Date("2026-11-10T18:00:00Z");
const ROW: CheckoutRow = {
  id: "c1000000-0000-4000-8000-000000000001",
  plan: "monthly",
  livemode: false,
  lookupKey: "plataforma_monthly_34900_mxn",
  amountCents: 34900,
  nextChargeAt: "2026-12-10T18:00:00Z",
  expiresAt: "2026-11-10T19:00:00Z",
  returnTo: "/inicio",
  state: "reserved",
  sessionId: null,
  url: null,
};
const INPUT: StartInput = { plan: "monthly", amountSeen: 34900, documentSeen: "d1000000-0000-4000-8000-000000000001", returnTo: "/inicio", ip: "203.0.113.1", userAgent: "Navegador" };
const PRICE = { id: "price_1", lookup_key: ROW.lookupKey, active: true, currency: "mxn", unit_amount: 34900, tax_behavior: "inclusive", livemode: false, recurring: { interval: "month", interval_count: 1 }, currency_options: { mxn: { unit_amount: 34900, tax_behavior: "inclusive" } } };
const SESSION = { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open" };

const ok = (body: unknown): StripeAnswer => ({ status: "ok", body });

interface Setup {
  begin?: BeginAnswer[];
  creating?: Awaited<ReturnType<CheckoutStore["creating"]>>[];
  access?: boolean;
  prices?: unknown[];
  customer?: unknown;
  subscriptions?: unknown[];
  subscriptionsMore?: boolean;
  create?: StripeWriteAnswer[];
  session?: unknown;
  status?: Awaited<ReturnType<CheckoutStore["status"]>>[];
  key?: boolean;
}

function setup(s: Setup = {}) {
  const calls: string[] = [];
  const queue = <T,>(list: T[] | undefined, fallback: T) => () => (list && list.length > 0 ? (list.shift() as T) : fallback);
  const nextBegin = queue(s.begin, { answer: "reserved", checkout: ROW, customer: "cus_1" } as BeginAnswer);
  const nextCreating = queue(s.creating, { answer: "creating", checkout: { ...ROW, state: "creating" } } as Awaited<ReturnType<CheckoutStore["creating"]>>);
  const nextCreate = queue(s.create, { status: "ok", body: SESSION } as StripeWriteAnswer);
  const nextStatus = queue(s.status, { mine: true, id: ROW.id, state: "open", returnTo: "/inicio", subscriptionId: null, live: false } as Awaited<ReturnType<CheckoutStore["status"]>>);
  const store: CheckoutStore = {
    offer: vi.fn(),
    accountFacts: vi.fn(async () => {
      calls.push("facts");
      return {
        now: NOW,
        email: "ana@prueba.test",
        graceDays: 7,
        account: {
          suspended: false,
          paidThrough: s.access ? new Date("2027-01-01T00:00:00Z") : null,
          lastRenewalFailedAt: null,
          endedAt: null,
          refunded: false,
          courtesy: [],
        },
      };
    }),
    standing: vi.fn(),
    begin: vi.fn(async () => (calls.push("begin"), nextBegin())),
    creating: vi.fn(async () => (calls.push("creating"), nextCreating())),
    customerRecord: vi.fn(async () => (calls.push("customer_record"), "recorded" as const)),
    sessionRecord: vi.fn(async () => (calls.push("session_record"), "recorded" as const)),
    close: vi.fn(async (_claims, _id, state) => (calls.push(`close:${state}`), "closed" as const)),
    status: vi.fn(async () => (calls.push("status"), nextStatus())),
  };
  const get = vi.fn(async (path: string, query?: Readonly<Record<string, string | readonly string[]>>): Promise<StripeAnswer> => {
    calls.push(`get ${path}`);
    if (path === "/v1/prices") return ok({ data: s.prices ?? [PRICE] });
    if (path.startsWith("/v1/customers/")) return ok(s.customer ?? { id: "cus_1", balance: 0 });
    if (path === "/v1/subscriptions") return ok({ data: s.subscriptions ?? [], has_more: s.subscriptionsMore ?? false, query });
    if (path.startsWith("/v1/checkout/sessions/")) return ok(s.session ?? { id: "cs_test_1", status: "open", subscription: null });
    return { status: "not_found" };
  });
  const post = vi.fn(async (path: string, form: Readonly<Record<string, string>>, key: string): Promise<StripeWriteAnswer> => {
    calls.push(`post ${path} ${key}`);
    if (path === "/v1/customers") return { status: "ok", body: { id: "cus_new" } };
    if (path === "/v1/checkout/sessions") return nextCreate();
    if (path.endsWith("/expire")) return { status: "ok", body: { id: "cs_test_old", status: "expired" } };
    return { status: "rejected" };
  });
  const report = vi.fn(async () => undefined);
  const pass: SessionCheck = { kind: "pass", claims: CLAIMS };
  const service = createCheckout({
    store,
    stripe: () => (s.key === false ? null : { get, post, live: false, test: false }),
    checkSession: vi.fn(async () => pass),
    siteUrl: () => "https://plataforma.test",
    report,
    now: () => NOW,
  });
  return { service, store, get, post, report, calls };
}

describe("salir a pagar", () => {
  it("con todo en orden: cliente, sin suscripciones en Stripe, el precio que cuadra, crear la sesión y anotarla, en ese orden", async () => {
    const t = setup();
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "redirect", url: SESSION.url });
    expect(t.calls).toEqual([
      "facts",
      "begin",
      "get /v1/customers/cus_1",
      "get /v1/subscriptions",
      "get /v1/prices",
      "creating",
      `post /v1/checkout/sessions checkout:${ROW.id}`,
      "session_record",
    ]);
  });

  it("la sesión lleva lo reservado: el cliente, el precio, la cuenta en la suscripción, el vencimiento, solo tarjeta y sin precio local", async () => {
    const t = setup();
    await t.service.startCheckout(READER, INPUT);
    const [, form] = t.post.mock.calls.find(([path]) => path === "/v1/checkout/sessions") as unknown as [string, Record<string, string>];
    expect(form).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      "line_items[0][price]": "price_1",
      "line_items[0][quantity]": "1",
      client_reference_id: ROW.id,
      "metadata[profile_id]": CLAIMS.userId,
      "metadata[checkout_id]": ROW.id,
      "subscription_data[metadata][profile_id]": CLAIMS.userId,
      "subscription_data[metadata][checkout_id]": ROW.id,
      success_url: "https://plataforma.test/suscripcion/confirmando?sesion={CHECKOUT_SESSION_ID}",
      cancel_url: "https://plataforma.test/planes?cancelado=1",
      expires_at: String(Date.parse(ROW.expiresAt) / 1000),
      locale: "es-419",
      "allowed_payment_method_types[0]": "card",
      "adaptive_pricing[enabled]": "false",
    });
    expect(form["custom_text[submit][message]"]).toContain("IVA incluido");
    expect(Object.keys(form).some((name) => name.startsWith("consent_collection"))).toBe(false);
  });

  it("sin cliente, lo crea con su llave por cuenta y modo, y lo anota", async () => {
    const t = setup({ begin: [{ answer: "reserved", checkout: ROW, customer: null }] });
    await t.service.startCheckout(READER, INPUT);
    const [path, form, key] = t.post.mock.calls[0] as unknown as [string, Record<string, string>, string];
    expect(path).toBe("/v1/customers");
    expect(key).toBe(`customer:${CLAIMS.userId}:test`);
    expect(form).toEqual({ email: "ana@prueba.test", "metadata[profile_id]": CLAIMS.userId });
    expect(t.store.customerRecord).toHaveBeenCalledWith(CLAIMS, false, "cus_new");
  });

  it.each([
    [{ status: "rejected" }, "checkout_customer_rejected"],
    [{ status: "unknown" }, "checkout_stripe_unknown"],
    [{ status: "unauthorized" }, "checkout_key_rejected"],
  ] as const)("si crear el cliente contesta %j, no se sigue y se reporta %s", async (answer, code) => {
    const t = setup({ begin: [{ answer: "reserved", checkout: ROW, customer: null }] });
    t.post.mockImplementationOnce(async () => answer);
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.report).toHaveBeenCalledWith(code);
    expect(t.store.customerRecord).not.toHaveBeenCalled();
  });

  it("quien ya tiene acceso no sale a pagar, y no se reserva nada", async () => {
    const t = setup({ access: true });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "has_access" });
    expect(t.calls).toEqual(["facts"]);
  });

  it.each(["active", "trialing", "past_due", "incomplete", "unpaid", "paused"])(
    "una suscripción %s en Stripe que la base no conoce es un pago en curso: abandona la reserva y no crea nada",
    async (status) => {
      const t = setup({ subscriptions: [{ id: "sub_x", status }] });
      expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "in_progress" });
      expect(t.calls).toContain("close:abandoned");
      expect(t.post).not.toHaveBeenCalledWith("/v1/checkout/sessions", expect.anything(), expect.anything());
    },
  );

  it("una suscripción cancelada o vencida en Stripe no estorba", async () => {
    const t = setup({ subscriptions: [{ id: "sub_a", status: "canceled" }, { id: "sub_b", status: "incomplete_expired" }] });
    expect((await t.service.startCheckout(READER, INPUT)).kind).toBe("redirect");
  });

  it("el precio se pide con sus monedas expandidas, y las suscripciones sin las canceladas, hasta 100", async () => {
    const t = setup();
    await t.service.startCheckout(READER, INPUT);
    expect(t.get).toHaveBeenCalledWith("/v1/prices", { "lookup_keys[]": [ROW.lookupKey], "expand[]": ["data.currency_options"], limit: "10" });
    expect(t.get).toHaveBeenCalledWith("/v1/subscriptions", { customer: "cus_1", limit: "100" });
  });

  it("si las suscripciones del cliente no caben en una página, no se supo: no se crea nada", async () => {
    const t = setup({ subscriptionsMore: true });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.report).toHaveBeenCalledWith("checkout_customer_subscriptions");
    expect(t.calls.some((call) => call.startsWith("post /v1/checkout"))).toBe(false);
  });

  it("si no se pudieron leer las suscripciones del cliente, no se crea nada: la reserva queda para reintentar", async () => {
    const t = setup();
    t.get.mockImplementation(async (path: string) => (path === "/v1/subscriptions" ? { status: "unavailable" } : path === "/v1/prices" ? ok({ data: [PRICE] }) : ok({ id: "cus_1", balance: 0 })));
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.calls.some((call) => call.startsWith("post /v1/checkout"))).toBe(false);
    expect(t.calls.some((call) => call.startsWith("close:"))).toBe(false);
  });

  it.each([
    ["sin precio con esa clave", []],
    ["dos precios con la misma clave", [PRICE, { ...PRICE, id: "price_2" }]],
    ["otro monto", [{ ...PRICE, unit_amount: 39900 }]],
    ["otra moneda", [{ ...PRICE, currency: "usd" }]],
    ["sin el IVA incluido", [{ ...PRICE, tax_behavior: "exclusive" }]],
    ["otro intervalo", [{ ...PRICE, recurring: { interval: "year", interval_count: 1 } }]],
    ["cada dos meses", [{ ...PRICE, recurring: { interval: "month", interval_count: 2 } }]],
    ["inactivo", [{ ...PRICE, active: false }]],
    ["del modo real", [{ ...PRICE, livemode: true }]],
    ["con precios en otras monedas", [{ ...PRICE, currency_options: { mxn: {}, usd: {} } }]],
    ["sin sus monedas expandidas", [{ ...PRICE, currency_options: undefined }]],
  ])("un precio que no cuadra (%s): no se crea, se abandona y se reporta", async (_name, prices) => {
    const t = setup({ prices });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.calls).toContain("close:abandoned");
    expect(t.report).toHaveBeenCalledWith("checkout_price_mismatch");
    expect(t.calls.some((call) => call.startsWith("post /v1/checkout"))).toBe(false);
  });

  it("un cliente con saldo a favor no paga: la primera factura saldría en cero, y se reporta", async () => {
    const t = setup({ customer: { id: "cus_1", balance: -5000 } });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.report).toHaveBeenCalledWith("checkout_customer_balance");
    expect(t.calls).toContain("close:abandoned");
  });

  it("si crear no se supo, la salida queda creando, y el reintento manda exactamente lo mismo con la misma llave", async () => {
    const t = setup({ create: [{ status: "unknown" }], begin: [{ answer: "reserved", checkout: ROW, customer: "cus_1" }, { answer: "reuse", checkout: { ...ROW, state: "creating" }, customer: "cus_1" }] });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.calls.some((call) => call.startsWith("close:"))).toBe(false);
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "redirect", url: SESSION.url });
    const creates = t.post.mock.calls.filter(([path]) => path === "/v1/checkout/sessions");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual(creates[0]);
    expect(t.report).toHaveBeenCalledWith("checkout_stripe_unknown");
  });

  it("si Stripe contesta crear sin la forma de siempre (otro dominio), no se manda a nadie y se reporta", async () => {
    const t = setup({ create: [{ status: "ok", body: { ...SESSION, url: "https://pago.ejemplo.com/c/pay/cs_test_1" } }] });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.report).toHaveBeenCalledWith("checkout_stripe_unknown");
    expect(t.calls).not.toContain("session_record");
  });

  it("si Stripe rechaza la llave al crear, se reporta la llave", async () => {
    const t = setup({ create: [{ status: "unauthorized" }] });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.report).toHaveBeenCalledWith("checkout_key_rejected");
  });

  it("si Stripe rechaza crearla, se abandona y se reporta", async () => {
    const t = setup({ create: [{ status: "rejected" }] });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.calls).toContain("close:abandoned");
    expect(t.report).toHaveBeenCalledWith("checkout_create_rejected");
  });

  it("una abierta que todavía sirve se reusa: su dirección, sin volver a pedirle nada a Stripe", async () => {
    const open = { ...ROW, state: "open" as const, sessionId: "cs_test_1", url: SESSION.url };
    const t = setup({ begin: [{ answer: "reuse", checkout: open, customer: "cus_1" }] });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "redirect", url: SESSION.url });
    expect(t.post).not.toHaveBeenCalled();
  });

  it("una abierta de otro plan se vence en Stripe, se cierra y se reserva otra", async () => {
    const other = { ...ROW, id: "c2000000-0000-4000-8000-000000000002", plan: "annual" as const, state: "open" as const, sessionId: "cs_test_old", url: "https://checkout.stripe.com/c/pay/cs_test_old" };
    const t = setup({ begin: [{ answer: "open_other", checkout: other, customer: "cus_1" }] });
    expect((await t.service.startCheckout(READER, INPUT)).kind).toBe("redirect");
    expect(t.calls.slice(0, 5)).toEqual(["facts", "begin", `post /v1/checkout/sessions/cs_test_old/expire expire:${other.id}`, "close:expired", "begin"]);
  });

  it("si al vencerla Stripe dice que ya se pagó, es un pago en curso: se anota completada y no se abre otra", async () => {
    const other = { ...ROW, id: "c2000000-0000-4000-8000-000000000002", plan: "annual" as const, state: "open" as const, sessionId: "cs_test_old", url: "https://checkout.stripe.com/c/pay/cs_test_old" };
    const t = setup({ begin: [{ answer: "open_other", checkout: other, customer: "cus_1" }], session: { id: "cs_test_old", status: "complete", subscription: "sub_paid" } });
    t.post.mockImplementation(async (path: string) => (path.endsWith("/expire") ? { status: "rejected" } : { status: "ok", body: SESSION }));
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "in_progress" });
    expect(t.store.close).toHaveBeenCalledWith(CLAIMS, other.id, "completed", "sub_paid");
    expect(t.calls.filter((call) => call === "begin")).toHaveLength(1);
  });

  it("una reservada de otro plan, que nunca se pidió a Stripe, se abandona sin preguntarle", async () => {
    const other = { ...ROW, id: "c2000000-0000-4000-8000-000000000002", plan: "annual" as const };
    const t = setup({ begin: [{ answer: "open_other", checkout: other, customer: "cus_1" }] });
    await t.service.startCheckout(READER, INPUT);
    expect(t.calls.slice(0, 4)).toEqual(["facts", "begin", "close:abandoned", "begin"]);
  });

  it("una reserva vieja (stale) se abandona y se reserva otra, una sola vez", async () => {
    const t = setup({ creating: [{ answer: "stale" }] });
    expect((await t.service.startCheckout(READER, INPUT)).kind).toBe("redirect");
    expect(t.calls.filter((call) => call === "begin")).toHaveLength(2);
    expect(t.calls).toContain("close:abandoned");
  });

  it.each([
    [{ answer: "in_progress" }, { kind: "in_progress" }],
    [{ answer: "changed" }, { kind: "changed" }],
    [{ answer: "unavailable" }, { kind: "unavailable" }],
    [{ answer: "invalid" }, { kind: "invalid" }],
    [{ answer: "not_allowed", reason: "email_unverified" }, { kind: "not_allowed", reason: "email_unverified" }],
  ] as const)("lo que contesta la base (%j) se dice, sin hablar con Stripe", async (answer, expected) => {
    const t = setup({ begin: [answer as BeginAnswer] });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual(expected);
    expect(t.get).not.toHaveBeenCalled();
    expect(t.post).not.toHaveBeenCalled();
  });

  it("sin la llave de la salida a pagar no se reserva nada y se reporta", async () => {
    const t = setup({ key: false });
    expect(await t.service.startCheckout(READER, INPUT)).toEqual({ kind: "unavailable" });
    expect(t.report).toHaveBeenCalledWith("checkout_no_key");
    expect(t.store.begin).not.toHaveBeenCalled();
  });

  it("sin sesión, ni la base ni Stripe", async () => {
    const t = setup();
    const anonymous = createCheckout({
      store: t.store,
      stripe: () => ({ get: t.get, post: t.post, live: false, test: false }),
      checkSession: vi.fn(async (): Promise<SessionCheck> => ({ kind: "anonymous" })),
      siteUrl: () => "https://plataforma.test",
      report: t.report,
      now: () => NOW,
    });
    expect(await anonymous.startCheckout(READER, INPUT)).toEqual({ kind: "session", check: { kind: "anonymous" } });
    expect(t.calls).toEqual([]);
  });
});

describe("PA-32, cómo va el pago", () => {
  it.each(["", "cs_", "cs_test_", "sub_1", "cs_test_a b", `cs_test_${"a".repeat(300)}`])("una sesión sin forma (%j) no existe, sin preguntar a nadie", async (session) => {
    const t = setup();
    expect(await t.service.checkoutProgress(CLAIMS, session)).toEqual({ kind: "not_found" });
    expect(t.calls).toEqual([]);
  });

  it("la de otra persona no existe", async () => {
    const t = setup({ status: [{ mine: false }] });
    expect(await t.service.checkoutProgress(CLAIMS, "cs_test_1")).toEqual({ kind: "not_found" });
    expect(t.get).not.toHaveBeenCalled();
  });

  it("si Stripe dice que se completó, se anota con su suscripción y se espera el aviso: todavía sin acceso", async () => {
    const t = setup({
      session: { id: "cs_test_1", status: "complete", subscription: "sub_1" },
      status: [
        { mine: true, id: ROW.id, state: "open", returnTo: "/cursos/uno", subscriptionId: null, live: false },
        { mine: true, id: ROW.id, state: "completed", returnTo: "/cursos/uno", subscriptionId: "sub_1", live: false },
      ],
    });
    expect(await t.service.checkoutProgress(CLAIMS, "cs_test_1")).toEqual({ kind: "waiting", returnTo: "/cursos/uno" });
    expect(t.store.close).toHaveBeenCalledWith(CLAIMS, ROW.id, "completed", "sub_1");
  });

  it("con el aviso aplicado, listo, con su destino; y ya no le pregunta a Stripe", async () => {
    const t = setup({ status: [{ mine: true, id: ROW.id, state: "completed", returnTo: "/cursos/uno", subscriptionId: "sub_1", live: true }] });
    expect(await t.service.checkoutProgress(CLAIMS, "cs_test_1")).toEqual({ kind: "live", returnTo: "/cursos/uno" });
    expect(t.get).not.toHaveBeenCalled();
  });

  it("si Stripe dice que venció, se anota vencida y se dice", async () => {
    const t = setup({
      session: { id: "cs_test_1", status: "expired", subscription: null },
      status: [
        { mine: true, id: ROW.id, state: "open", returnTo: "/inicio", subscriptionId: null, live: false },
        { mine: true, id: ROW.id, state: "expired", returnTo: "/inicio", subscriptionId: null, live: false },
      ],
    });
    expect(await t.service.checkoutProgress(CLAIMS, "cs_test_1")).toEqual({ kind: "expired" });
    expect(t.store.close).toHaveBeenCalledWith(CLAIMS, ROW.id, "expired", null);
  });

  it("si Stripe no contesta, se sigue esperando", async () => {
    const t = setup();
    t.get.mockResolvedValue({ status: "unavailable" });
    expect(await t.service.checkoutProgress(CLAIMS, "cs_test_1")).toEqual({ kind: "waiting", returnTo: "/inicio" });
    expect(t.store.close).not.toHaveBeenCalled();
  });

  it("si Stripe dice que la sesión sigue abierta, no se pagó: se dice, sin esperar un aviso que no va a llegar", async () => {
    const t = setup({ session: { id: "cs_test_1", status: "open", subscription: null } });
    expect(await t.service.checkoutProgress(CLAIMS, "cs_test_1")).toEqual({ kind: "not_paid" });
    expect(t.store.close).not.toHaveBeenCalled();
  });

  it("si la base no contesta, no se supo, y se reporta", async () => {
    const t = setup();
    vi.mocked(t.store.status).mockRejectedValue(new Error("caída"));
    expect(await t.service.checkoutProgress(CLAIMS, "cs_test_1")).toEqual({ kind: "unavailable" });
    expect(t.report).toHaveBeenCalledWith("checkout_unavailable");
  });
});
