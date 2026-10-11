import { beforeEach, describe, expect, it, vi } from "vitest";

// Cómo se manda detrás de la respuesta la llamada a Auth de pedir un correo, con Next y el
// servicio simulados. Que la respuesta de verdad sale antes está en el extremo a extremo.

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  createAccountServices: vi.fn((deps: { defer: (work: () => Promise<void>) => Promise<void> }) => ({
    requestRegistration: { name: "registro", deps },
    requestRecovery: { name: "recuperación", deps },
    signIn: "no se usa",
  })),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/services/account/account", () => ({ createAccountServices: mocks.createAccountServices }));

import { deferAfterResponse, requestRecovery, requestRegistration } from "./mail-requests";

beforeEach(() => {
  mocks.after.mockReset();
});

describe("mandar un trabajo detrás de la respuesta", () => {
  it("se lo entrega a Next y regresa sin haberlo corrido", async () => {
    const work = vi.fn(() => Promise.resolve());
    await deferAfterResponse(work);
    expect(mocks.after).toHaveBeenCalledExactlyOnceWith(work);
    expect(work).not.toHaveBeenCalled();
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
