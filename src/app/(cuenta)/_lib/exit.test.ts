import { beforeEach, describe, expect, it, vi } from "vitest";

// Cómo sale una acción de la cuenta hacia otra pantalla, con el servicio simulado.

const calls = vi.hoisted(() => ({ order: [] as string[] }));
const mocks = vi.hoisted(() => ({
  signOut: vi.fn(() => {
    calls.order.push("signOut");
    return Promise.resolve("closed");
  }),
  forgetBrowserProofs: vi.fn(() => {
    calls.order.push("forgetBrowserProofs");
  }),
  leaveNotice: vi.fn(() => {
    calls.order.push("leaveNotice");
  }),
  redirect: vi.fn((to: string): never => {
    calls.order.push("redirect");
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: mocks.forgetBrowserProofs }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { leaveFor } from "./exit";

const jar = { get: () => undefined, set: () => undefined };

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
});

describe("salir de una acción hacia otra pantalla", () => {
  it("sin aviso y sin sesión que cerrar, solo redirige", async () => {
    await expect(leaveFor(jar, { to: "/inicio", notice: null })).rejects.toThrow("redirige a /inicio");
    expect(calls.order).toEqual(["redirect"]);
  });

  it("deja el aviso para la pantalla siguiente antes de redirigir", async () => {
    await expect(leaveFor(jar, { to: "/recuperar", notice: "choose_password" })).rejects.toThrow("redirige a /recuperar");
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "choose_password");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(calls.order).toEqual(["leaveNotice", "redirect"]);
  });

  it("si la guarda dijo que la sesión ya no vale, primero la cierra", async () => {
    await expect(leaveFor(jar, { to: "/recuperar", notice: "choose_password", closeSession: true })).rejects.toThrow();
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(jar);
    expect(calls.order).toEqual(["signOut", "leaveNotice", "redirect"]);
  });

  // Quien cierra su propia sesión sale de ese navegador: se lleva también el resguardo del
  // buzón y el factor a medias. Las salidas que cierran una sesión que la guarda rechazó no
  // lo piden: completar una recuperación deja el resguardo y sale por aquí mismo.
  it("si se le pide, después de cerrar la sesión olvida las pruebas de ese navegador", async () => {
    await expect(leaveFor(jar, { to: "/", notice: null, closeSession: true, forgetProofs: true })).rejects.toThrow("redirige a /");
    expect(mocks.forgetBrowserProofs).toHaveBeenCalledExactlyOnceWith(jar);
    expect(calls.order).toEqual(["signOut", "forgetBrowserProofs", "redirect"]);
  });

  it("y solo si se le pide: cerrar una sesión no se las lleva", async () => {
    await expect(leaveFor(jar, { to: "/entrar", notice: "password_changed", closeSession: true })).rejects.toThrow();
    await expect(leaveFor(jar, { to: "/entrar", notice: null, closeSession: true, forgetProofs: false })).rejects.toThrow();
    await expect(leaveFor(jar, { to: "/inicio", notice: null })).rejects.toThrow();
    expect(mocks.forgetBrowserProofs).not.toHaveBeenCalled();
  });

  it("solo cierra la sesión cuando se le pide", async () => {
    await expect(leaveFor(jar, { to: "/entrar", notice: null, closeSession: false })).rejects.toThrow();
    expect(mocks.signOut).not.toHaveBeenCalled();
    await expect(leaveFor(jar, { to: "/entrar", notice: null, closeSession: true })).rejects.toThrow();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });
});
