import { beforeEach, describe, expect, it, vi } from "vitest";

// Cómo se manda detrás de la respuesta la llamada a Auth de pedir un correo, con Next y el
// servicio simulados. Que con `next start` la respuesta de verdad sale antes se midió a mano
// el 2026-10-11 (TRD §9.3): ninguna prueba automática mide tiempos.

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  reportFailure: vi.fn(() => Promise.resolve()),
  createAccountServices: vi.fn((deps: { defer: (work: () => Promise<void>) => Promise<void> }) => ({
    requestRegistration: { name: "registro", deps },
    requestRecovery: { name: "recuperación", deps },
    signIn: "no se usa",
  })),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/services/error-reporting/server", () => ({ reportFailure: mocks.reportFailure }));
vi.mock("@/services/account/account", () => ({ createAccountServices: mocks.createAccountServices }));

import { deferAfterResponse, requestRecovery, requestRegistration } from "./mail-requests";

beforeEach(() => {
  mocks.after.mockReset();
  mocks.reportFailure.mockClear();
});

describe("mandar un trabajo detrás de la respuesta", () => {
  it("se lo entrega a Next y regresa sin haberlo corrido", async () => {
    const work = vi.fn(() => Promise.resolve());
    await deferAfterResponse(work);
    expect(mocks.after).toHaveBeenCalledExactlyOnceWith(work);
    expect(work).not.toHaveBeenCalled();
    expect(mocks.reportFailure).not.toHaveBeenCalled();
  });

  it("correr en el acto se reporta: el tiempo de esa respuesta vuelve a depender de Auth", async () => {
    mocks.after.mockImplementation(() => {
      throw new Error("`after()` will not work correctly, because `waitUntil` is not available in the current environment.");
    });
    const order: string[] = [];
    mocks.reportFailure.mockImplementationOnce(() => {
      order.push("reporte");
      return Promise.resolve();
    });
    await deferAfterResponse(() => {
      order.push("trabajo");
      return Promise.resolve();
    });
    expect(mocks.reportFailure).toHaveBeenCalledExactlyOnceWith("mail_not_deferred");
    // Primero el correo, después el reporte.
    expect(order).toEqual(["trabajo", "reporte"]);
  });

  it("y se reporta aunque el trabajo falle, sin tapar su fallo", async () => {
    mocks.after.mockImplementation(() => {
      throw new Error("sin petición");
    });
    await expect(deferAfterResponse(() => Promise.reject(new Error("Auth no contestó")))).rejects.toThrow("Auth no contestó");
    expect(mocks.reportFailure).toHaveBeenCalledExactlyOnceWith("mail_not_deferred");
  });

  it("si Next no puede encolarlo, lo corre en el acto: un envío anotado no se queda sin correo", async () => {
    mocks.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const work = vi.fn(() => Promise.resolve());
    await deferAfterResponse(work);
    expect(work).toHaveBeenCalledOnce();
  });

  it("en ese caso espera a que el trabajo termine", async () => {
    mocks.after.mockImplementation(() => {
      throw new Error("sin petición");
    });
    let done = false;
    await deferAfterResponse(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });
    expect(done).toBe(true);
  });
});

describe("los servicios de pedir correo de las pantallas", () => {
  it("se arman con ese modo de mandar el trabajo detrás, y con ningún otro", () => {
    expect(requestRegistration).toMatchObject({ name: "registro", deps: { defer: deferAfterResponse } });
    expect(requestRecovery).toMatchObject({ name: "recuperación", deps: { defer: deferAfterResponse } });
  });
});
