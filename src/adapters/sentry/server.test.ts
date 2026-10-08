import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_COLLECTION } from "./options";

// Encender Sentry es lo único que este archivo hace. Lo que importa comprobar: que sin
// dirección no se enciende, y que cuando se enciende lleva las opciones del filtro.

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureRequestError: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

const serverEnv = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock("@/config/env", () => ({ getEnv: () => serverEnv.current }));

import { captureRequestError, startServerErrorReporting } from "./server";

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

    expect(sentry.init).toHaveBeenCalledExactlyOnceWith({
      dsn: DSN,
      environment: "staging",
      dataCollection: DATA_COLLECTION,
      beforeSend: expect.any(Function),
    });
  });

  it("reporta el error de una petición con la función del SDK", () => {
    expect(captureRequestError).toBe(sentry.captureRequestError);
  });
});
