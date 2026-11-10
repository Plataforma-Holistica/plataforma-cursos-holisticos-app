import { describe, expect, it, vi } from "vitest";

import { createStripeApi, createStripeWriter, STRIPE_API_VERSION } from "./api";

// El adaptador de Stripe (T-303), con `fetch` simulado: qué pide y qué contesta según el estado. Que Stripe conteste así se midió contra el sandbox el 2026-11-07.

const KEY = ["rk", "test", "prueba0123456789"].join("_");

function withStatus(status: number, body: unknown = {}) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}

describe("el adaptador de Stripe", () => {
  it("pide con la llave y la versión fija, y repite expand[]", async () => {
    const send = withStatus(200, { id: "in_1" });
    const get = createStripeApi({ secretKey: KEY, fetch: send });
    expect(await get("/v1/invoices/in_1", { "expand[]": ["a.b", "c"], limit: "100" })).toEqual({ status: "ok", body: { id: "in_1" } });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/invoices/in_1?expand%5B%5D=a.b&expand%5B%5D=c&limit=100");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}`, "stripe-version": STRIPE_API_VERSION });
  });

  it.each([
    [404, "not_found"],
    [400, "rejected"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "unavailable"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("un %i es %s, y no se lee su cuerpo", async (status, answer) => {
    const response = new Response(JSON.stringify({ error: { message: "datos de la cuenta" } }), { status, headers: { "content-type": "application/json" } });
    const get = createStripeApi({ secretKey: KEY, fetch: vi.fn(() => Promise.resolve(response)) });
    expect(await get("/v1/subscriptions/sub_1")).toEqual({ status: answer });
    expect(response.bodyUsed).toBe(false);
  });

  it("si la red falla o se acaba el tiempo, no se supo", async () => {
    const get = createStripeApi({ secretKey: KEY, fetch: vi.fn(() => Promise.reject(new Error("corte"))) });
    expect(await get("/v1/subscriptions/sub_1")).toEqual({ status: "unavailable" });
  });

  it("un 200 que no es JSON tampoco lanza", async () => {
    const get = createStripeApi({ secretKey: KEY, fetch: vi.fn(() => Promise.resolve(new Response("<html>", { status: 200 }))) });
    expect(await get("/v1/subscriptions/sub_1")).toEqual({ status: "unavailable" });
  });

  it.each(["/v1/subscriptions/sub_1/../charges", "/v1/subscriptions/sub 1", "/v2/x", "https://otro.test/v1/x", "/v1/subscriptions/sub_1?x=1"])(
    "una ruta sin forma (%s) no sale",
    async (path) => {
      const send = withStatus(200);
      const get = createStripeApi({ secretKey: KEY, fetch: send });
      expect(await get(path)).toEqual({ status: "rejected" });
      expect(send).not.toHaveBeenCalled();
    },
  );
});

// La escritura (T-302, segunda solicitud): crear el cliente y la sesión de pago, y vencer una sesión. Siempre con su llave de idempotencia, que hace que repetir la
// misma petición devuelva lo mismo. Distingue lo que se sabe que no pasó (un rechazo) de lo que pudo haber pasado (no se supo): con eso decide el servicio si
// reintenta con lo mismo o abandona.
describe("la escritura en Stripe", () => {
  const FORM = { customer: "cus_1", "line_items[0][price]": "price_1" };
  const IDEMPOTENCY = "checkout:c1000000-0000-4000-8000-000000000001";

  it("manda el formulario codificado, con la llave, la versión y la llave de idempotencia", async () => {
    const send = withStatus(200, { id: "cs_test_1" });
    const post = createStripeWriter({ secretKey: KEY, fetch: send });
    expect(await post("/v1/checkout/sessions", FORM, IDEMPOTENCY)).toEqual({ status: "ok", body: { id: "cs_test_1" } });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      "stripe-version": STRIPE_API_VERSION,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": IDEMPOTENCY,
    });
    expect(init.body).toBe("customer=cus_1&line_items%5B0%5D%5Bprice%5D=price_1");
  });

  it.each([
    [400, { error: { type: "invalid_request_error" } }, "rejected"],
    [402, { error: { type: "card_error" } }, "rejected"],
    [404, {}, "not_found"],
    [401, {}, "unauthorized"],
    [403, {}, "unauthorized"],
    // La misma llave con otros parámetros, o con la petición original todavía en curso: pudo haberse creado.
    [400, { error: { type: "idempotency_error" } }, "unknown"],
    [409, { error: { type: "idempotency_error" } }, "unknown"],
    [429, {}, "unknown"],
    [500, {}, "unknown"],
  ] as const)("un %i (%j) es %s", async (status, body, answer) => {
    const post = createStripeWriter({ secretKey: KEY, fetch: withStatus(status, body) });
    expect(await post("/v1/customers", { email: "a@prueba.test" }, IDEMPOTENCY)).toEqual({ status: answer });
  });

  it("si la red falla, se acaba el tiempo o el cuerpo no es JSON, no se supo", async () => {
    const failing = createStripeWriter({ secretKey: KEY, fetch: vi.fn(() => Promise.reject(new Error("corte"))) });
    expect(await failing("/v1/customers", {}, IDEMPOTENCY)).toEqual({ status: "unknown" });
    const html = createStripeWriter({ secretKey: KEY, fetch: vi.fn(() => Promise.resolve(new Response("<html>", { status: 200 }))) });
    expect(await html("/v1/customers", {}, IDEMPOTENCY)).toEqual({ status: "unknown" });
  });

  it.each(["/v1/customers", "/v1/checkout/sessions", "/v1/checkout/sessions/cs_test_a1B2/expire"])("escribe en %s", async (path) => {
    const send = withStatus(200, {});
    expect((await createStripeWriter({ secretKey: KEY, fetch: send })(path, {}, IDEMPOTENCY)).status).toBe("ok");
  });

  it.each(["/v1/prices", "/v1/subscriptions/sub_1", "/v1/refunds", "/v1/checkout/sessions/cs_test_1/../expire", "/v1/customers/cus_1", "https://otro.test/v1/customers"])(
    "no escribe en nada más (%s)",
    async (path) => {
      const send = withStatus(200);
      expect(await createStripeWriter({ secretKey: KEY, fetch: send })(path, {}, IDEMPOTENCY)).toEqual({ status: "rejected" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["", "sin forma", "checkout:no-es-uuid", `checkout:${"a".repeat(300)}`])("sin una llave de idempotencia con forma (%j), no sale", async (key) => {
    const send = withStatus(200);
    expect(await createStripeWriter({ secretKey: KEY, fetch: send })("/v1/customers", {}, key)).toEqual({ status: "rejected" });
    expect(send).not.toHaveBeenCalled();
  });
});
