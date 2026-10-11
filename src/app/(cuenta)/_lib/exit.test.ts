import { beforeEach, describe, expect, it, vi } from "vitest";

// Cómo sale una acción de la cuenta hacia otra pantalla, con el servicio simulado.

const calls = vi.hoisted(() => ({ order: [] as string[] }));
const mocks = vi.hoisted(() => ({
  signOut: vi.fn(() => {
    calls.order.push("signOut");
    return Promise.resolve("closed");
  }),
  leaveNotice: vi.fn(() => {
    calls.order.push("leaveNotice");
  }),
  redirect: vi.fn((to: string): never => {
    calls.order.push("redirect");
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut }));
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

  it("solo cierra la sesión cuando se le pide", async () => {
    await expect(leaveFor(jar, { to: "/entrar", notice: null, closeSession: false })).rejects.toThrow();
    expect(mocks.signOut).not.toHaveBeenCalled();
    await expect(leaveFor(jar, { to: "/entrar", notice: null, closeSession: true })).rejects.toThrow();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });
});
