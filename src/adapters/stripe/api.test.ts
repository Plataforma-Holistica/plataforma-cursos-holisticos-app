import { describe, expect, it, vi } from "vitest";

import { createStripeApi, STRIPE_API_VERSION } from "./api";

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
    const get = createStripeApi({ secretKey: KEY, fetch: withStatus(status, { error: { message: "datos de la cuenta" } }) });
    expect(await get("/v1/subscriptions/sub_1")).toEqual({ status: answer });
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
