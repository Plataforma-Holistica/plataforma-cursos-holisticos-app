import { beforeEach, describe, expect, it, vi } from "vitest";

// «Continuar al pago» (PA-04; T-302), con el servicio simulado: qué le pasa al servicio y qué devuelve. Lo que hace el servicio de
// verdad lo prueban src/services/billing/checkout.test.ts y tests/integration/117-pago.test.ts.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  return {
    startCheckout: logged("startCheckout", () => Promise.resolve<unknown>({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" })),
    signOut: logged("signOut", () => Promise.resolve("closed")),
    forgetBrowserProofs: logged("forgetBrowserProofs", () => undefined),
    leaveNotice: logged("leaveNotice", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push(`redirect ${to}`);
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
    requestOrigin: vi.fn(),
    proxyIsTrusted: vi.fn(() => true),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar, requestOrigin: mocks.requestOrigin }));
vi.mock("@/services/billing/checkout-service", () => ({ startCheckout: mocks.startCheckout }));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: mocks.forgetBrowserProofs }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
// La huella de la dirección pide el secreto de la configuración, que aquí no hay; la acción no la usa.
vi.mock("@/services/account/fingerprint", () => ({ fingerprint: () => "huella" }));
vi.mock("@/services/account/origin", async (actual) => ({ ...(await actual<typeof import("@/services/account/origin")>()), proxyIsTrusted: mocks.proxyIsTrusted }));

import { startCheckoutAction } from "@/app/planes/actions";

const jar = { get: () => undefined, set: () => undefined };
const DOC = "11111111-2222-4333-8444-555555555555";
const previous = { kind: "idle" } as const;

function form(...values: [string, string][]): FormData {
  const data = new FormData();
  for (const [field, value] of values) data.append(field, value);
  return data;
}

const FULL: [string, string][] = [
  ["plan", "annual"],
  ["monto", "349000"],
  ["texto", DOC],
  ["volver", "/cursos/uno"],
  ["acepto", "on"],
];

function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
  mocks.requestOrigin.mockResolvedValue({ realIp: "203.0.113.7", userAgent: "Navegador de prueba" });
});

describe("«Continuar al pago»", () => {
  it("le pasa al servicio lo que se vio, el destino validado y el origen de la petición, y lleva a Stripe", async () => {
    await expect(startCheckoutAction(previous, form(...FULL))).rejects.toThrow("redirige");
    expect(mocks.startCheckout).toHaveBeenCalledExactlyOnceWith(jar, {
      plan: "annual",
      amountSeen: 349000,
      documentSeen: DOC,
      returnTo: "/cursos/uno",
      ip: "203.0.113.7",
      userAgent: "Navegador de prueba",
    });
    expect(calls.order).toEqual(["startCheckout", "redirect https://checkout.stripe.com/c/pay/cs_test_1"]);
  });

  it("sin un intermediario de fiar, la dirección no se conoce: no se anota la que diga la cabecera", async () => {
    mocks.proxyIsTrusted.mockReturnValueOnce(false);
    await expect(startCheckoutAction(previous, form(...FULL))).rejects.toThrow("redirige");
    expect(mocks.startCheckout.mock.calls[0]?.[1]).toMatchObject({ ip: null, userAgent: "Navegador de prueba" });
  });

  it("un destino que la lista no admite se cambia por el inicio, antes del servicio", async () => {
    await expect(startCheckoutAction(previous, form(...FULL.map(([k, v]): [string, string] => (k === "volver" ? [k, "https://otro.example/"] : [k, v]))))).rejects.toThrow("redirige");
    expect(mocks.startCheckout.mock.calls[0]?.[1]).toMatchObject({ returnTo: "/inicio" });
  });

  it("sin plan, o sin la casilla, no llama a nadie y lo dice", async () => {
    expect(await startCheckoutAction(previous, form(...FULL.filter(([k]) => k !== "plan")))).toEqual({ kind: "problem", problem: "choose_plan", plan: null, attempt: 1 });
    expect(await startCheckoutAction(previous, form(...FULL.filter(([k]) => k !== "acepto")))).toEqual({ kind: "problem", problem: "must_accept", plan: "annual", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("sin el monto o el texto vistos, cambió: no llama a nadie", async () => {
    expect(await startCheckoutAction(previous, form(...FULL.filter(([k]) => k !== "texto")))).toEqual({ kind: "answer", answer: "changed", plan: "annual", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it.each([
    [{ kind: "changed" }, "changed"],
    [{ kind: "in_progress" }, "in_progress"],
    [{ kind: "has_access" }, "has_access"],
    [{ kind: "unavailable" }, "unavailable"],
    [{ kind: "not_allowed", reason: "email_unverified" }, "email_unverified"],
  ])("lo que contesta el servicio (%j) se dice en la pantalla", async (answer, said) => {
    once("startCheckout", answer);
    expect(await startCheckoutAction({ kind: "answer", answer: "changed", plan: null, attempt: 4 }, form(...FULL))).toEqual({ kind: "answer", answer: said, plan: "annual", attempt: 5 });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("sin sesión sale a entrar y vuelve a los planes con el plan y el destino", async () => {
    once("startCheckout", { kind: "session", check: { kind: "anonymous" } });
    await expect(startCheckoutAction(previous, form(...FULL))).rejects.toThrow("redirige");
    expect(calls.order.at(-1)).toBe(`redirect /entrar?volver=${encodeURIComponent("/planes?plan=annual&volver=%2Fcursos%2Funo")}`);
  });

  it("una cuenta suspendida se dice aquí, sin salir", async () => {
    once("startCheckout", { kind: "session", check: { kind: "suspended" } });
    expect(await startCheckoutAction(previous, form(...FULL))).toEqual({ kind: "answer", answer: "suspended", plan: "annual", attempt: 1 });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("si la guarda no supo, no se pudo", async () => {
    once("startCheckout", { kind: "session", check: { kind: "unavailable" } });
    expect(await startCheckoutAction(previous, form(...FULL))).toEqual({ kind: "answer", answer: "unavailable", plan: "annual", attempt: 1 });
  });

  it("lo que no es un formulario no llama a nadie", async () => {
    expect(await startCheckoutAction(previous, "no" as unknown as FormData)).toEqual({ kind: "idle" });
    expect(calls.order).toEqual([]);
  });
});
