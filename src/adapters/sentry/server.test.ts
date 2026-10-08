import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_COLLECTION } from "./options";

// Encender Sentry es lo único que este archivo hace. Lo que importa comprobar: que sin
// dirección no se enciende, y que cuando se enciende lleva las opciones del filtro.

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRequestError: vi.fn(),
  httpIntegration: vi.fn((options: unknown) => ({ name: "Http", options })),
}));
vi.mock("@sentry/nextjs", () => sentry);

const serverEnv = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock("@/config/env", () => ({ getEnv: () => serverEnv.current }));

import { captureRequestError } from "./request-error";
import { startServerErrorReporting } from "./server";

const DSN = ["https://clave-publica", "o1.ingest.sentry.example/1"].join("@");

beforeEach(() => {
  vi.clearAllMocks();
  serverEnv.current = {};
});

describe("Sentry en el servidor", () => {
  it("sin dirección, no se enciende", () => {
    serverEnv.current = { APP_ENV: "local" };

    startServerErrorReporting();

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("con dirección, se enciende con el entorno y el filtro", () => {
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };

    startServerErrorReporting();

    expect(sentry.init).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        dsn: DSN,
        environment: "staging",
        dataCollection: DATA_COLLECTION,
        beforeSend: expect.any(Function),
        tracesSampleRate: 0,
        integrations: expect.any(Function),
      }),
    );
  });

  // Por omisión el servidor le avisa a Sentry de cada petición, haya error o no (el conteo
  // de sesiones), y guarda como contexto todo lo que se escribe en la consola.
  it("solo errores: sin el aviso por petición y sin la consola como contexto", () => {
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };
    startServerErrorReporting();

    const { integrations } = sentry.init.mock.calls[0]?.[0] as {
      integrations: (defaults: { name: string }[]) => { name: string; options?: unknown }[];
    };
    const result = integrations([
      { name: "InboundFilters" },
      { name: "Http" },
      { name: "ProcessSession" },
      { name: "Console" },
      { name: "OnUncaughtException" },
    ]);

    expect(result.map(({ name }) => name)).toEqual(["InboundFilters", "OnUncaughtException", "Http"]);
    expect(result.at(-1)?.options).toEqual({
      disableIncomingRequestSpans: true,
      sessions: false,
      tracePropagation: false,
    });
  });

  it("reporta el error de una petición con la función del SDK", () => {
    expect(captureRequestError).toBe(sentry.captureRequestError);
  });
});
