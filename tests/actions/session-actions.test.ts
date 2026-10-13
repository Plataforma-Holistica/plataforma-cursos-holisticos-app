import { beforeEach, describe, expect, it, vi } from "vitest";

// «Salir» (FL-05, A1), con el servicio simulado: qué llama, en qué orden y a dónde va.

const calls = vi.hoisted(() => ({ order: [] as string[], closing: "closed" }));
const mocks = vi.hoisted(() => ({
  signOut: vi.fn(() => {
    calls.order.push("signOut");
    return Promise.resolve(calls.closing);
  }),
  forgetBrowserProofs: vi.fn(() => {
    calls.order.push("forgetBrowserProofs");
  }),
  redirect: vi.fn((to: string): never => {
    calls.order.push("redirect");
    throw new Error(`redirige a ${to}`);
  }),
  cookieJar: vi.fn(),
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: mocks.forgetBrowserProofs }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";

const jar = { get: () => undefined, set: () => undefined };

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.closing = "closed";
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("«Salir»", () => {
  it("cierra la sesión, se lleva las pruebas de ese navegador y solo entonces va a la portada", async () => {
    await expect(signOutAction()).rejects.toThrow("redirige a /");
    expect(calls.order).toEqual(["signOut", "forgetBrowserProofs", "redirect"]);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(jar);
    // El resguardo del buzón y el factor a medias: quien sale ya no está en ese navegador.
    expect(mocks.forgetBrowserProofs).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("si Auth no pudo cerrar la sesión, se las lleva igual: la cookie ya se borró", async () => {
    calls.closing = "unknown";
    await expect(signOutAction()).rejects.toThrow("redirige a /");
    expect(calls.order).toEqual(["signOut", "forgetBrowserProofs", "redirect"]);
  });

  it("toma el tarro una sola vez, y es el mismo para las dos cosas", async () => {
    await expect(signOutAction()).rejects.toThrow();
    expect(mocks.cookieJar).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.forgetBrowserProofs).toHaveBeenCalledExactlyOnceWith(jar);
  });
});
