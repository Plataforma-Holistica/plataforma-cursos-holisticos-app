import { beforeEach, describe, expect, it, vi } from "vitest";

// La ruta que cierra una sesión rechazada, sin base: qué redirección sale con cada cosa
// que el servicio dice haber hecho. Que el servicio solo cierre lo que la guarda rechaza
// está en tests/integration/60-cuenta-guarda.test.ts.

const mocks = vi.hoisted(() => ({ closeRejectedSession: vi.fn(), leaveNotice: vi.fn(), jar: { get: vi.fn(), set: vi.fn() } }));
vi.mock("@/services/account/account", () => ({ closeRejectedSession: mocks.closeRejectedSession }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: () => Promise.resolve(mocks.jar) }));

import { NextRequest } from "next/server";

import * as route from "./route";

const ask = () => route.GET(new NextRequest("https://plataforma.example/sesion/cerrar?volver=%2F%2Fotro.example&to=https://otro.example"));

beforeEach(() => vi.clearAllMocks());

describe("GET /sesion/cerrar", () => {
  it.each([
    ["recover", "https://plataforma.example/recuperar"],
    ["sign_in", "https://plataforma.example/entrar"],
    ["none", "https://plataforma.example/entrar"],
    ["kept", "https://plataforma.example/inicio"],
  ])("%s: manda a %s, sin caché", async (result, location) => {
    mocks.closeRejectedSession.mockResolvedValue(result);
    const response = await ask();
    expect(response.status).toBe(307);
    // El destino sale de lo que hizo el servicio: nada de lo que traiga la dirección cuenta.
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate, max-age=0");
    expect(mocks.closeRejectedSession).toHaveBeenCalledExactlyOnceWith(mocks.jar);
  });

  it("solo quien tiene que recuperar su contraseña se lleva el aviso que lo explica", async () => {
    mocks.closeRejectedSession.mockResolvedValue("recover");
    await ask();
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(mocks.jar, "choose_password");

    for (const result of ["sign_in", "none", "kept"]) {
      vi.clearAllMocks();
      mocks.closeRejectedSession.mockResolvedValue(result);
      await ask();
      expect(mocks.leaveNotice).not.toHaveBeenCalled();
    }
  });

  it("no se resuelve al compilar", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });
});

describe("los demás métodos", () => {
  it("HEAD no corre el GET: no cierra nada", () => {
    const response = route.HEAD();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(mocks.closeRejectedSession).not.toHaveBeenCalled();
  });

  it("la ruta no exporta ningún otro método", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "HEAD", "dynamic"]);
  });
});
