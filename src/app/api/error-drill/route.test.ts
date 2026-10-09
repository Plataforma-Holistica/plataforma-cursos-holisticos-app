import { beforeEach, describe, expect, it, vi } from "vitest";

// El simulacro del registro de errores: una ruta que falla a propósito. La prueba cuida
// lo único que importa de ella, que en producción no existe.

vi.mock("@sentry/nextjs", () => ({ init: vi.fn(), captureRequestError: vi.fn() }));

const env = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock("@/config/env", () => ({ getEnv: () => env.current }));

import { ErrorDrill } from "@/services/error-reporting/server";

import { dynamic, GET } from "./route";

beforeEach(() => {
  env.current = {};
});

describe("GET /api/error-drill", () => {
  it.each(["local", "staging"])("en %s falla a propósito", (appEnv) => {
    env.current = { APP_ENV: appEnv };

    expect(() => GET()).toThrow(ErrorDrill);
  });

  it("en producción no existe: responde 404 y no falla", () => {
    env.current = { APP_ENV: "production" };

    const response = GET();

    expect(response.status).toBe(404);
  });

  // APP_ENV lo pone una persona en el panel. Si se equivoca, que la ruta no exista
  // depende también de lo que Vercel dice del despliegue, que nadie escribe a mano.
  it("en un despliegue de producción de Vercel no existe, diga lo que diga APP_ENV", () => {
    env.current = { APP_ENV: "staging", VERCEL_ENV: "production" };

    expect(GET().status).toBe(404);
  });

  it("en una vista previa de Vercel sí falla a propósito", () => {
    env.current = { APP_ENV: "staging", VERCEL_ENV: "preview" };

    expect(() => GET()).toThrow(ErrorDrill);
  });

  it("nunca se resuelve al compilar: fallaría la compilación", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
