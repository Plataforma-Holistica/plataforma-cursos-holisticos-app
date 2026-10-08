import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_COLLECTION } from "./options";

// Encender Sentry es lo único que estos dos archivos hacen. Lo que importa comprobar: que
// sin dirección no se enciende, y que cuando se enciende lleva las opciones del filtro.

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureRequestError: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);

const serverEnv = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock("@/config/env", () => ({ getEnv: () => serverEnv.current }));

const browserEnv = vi.hoisted(() => ({
  publicEnv: {} as { appEnv?: string; sentryDsn?: string },
}));
vi.mock("@/config/public-env", () => browserEnv);

const DSN = ["https://clave-publica", "o1.ingest.sentry.example/1"].join("@");

beforeEach(() => {
  vi.clearAllMocks();
  serverEnv.current = {};
  browserEnv.publicEnv = {};
});

describe("en el servidor", () => {
  it("sin dirección, no se enciende", async () => {
    const { startServerErrorReporting } = await import("./server");
    serverEnv.current = { APP_ENV: "local" };

    startServerErrorReporting();

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("con dirección, se enciende con el entorno y el filtro", async () => {
    const { startServerErrorReporting } = await import("./server");
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };

    startServerErrorReporting();

    expect(sentry.init).toHaveBeenCalledOnce();
    expect(sentry.init).toHaveBeenCalledWith({
      dsn: DSN,
      environment: "staging",
      dataCollection: DATA_COLLECTION,
      beforeSend: expect.any(Function),
    });
  });

  it("reporta el error de una petición con la función del SDK", async () => {
    const { captureRequestError } = await import("./server");

    expect(captureRequestError).toBe(sentry.captureRequestError);
  });
});

describe("en el navegador", () => {
  it("sin dirección, no se enciende", async () => {
    const { startBrowserErrorReporting } = await import("./browser");

    startBrowserErrorReporting();

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("con dirección, se enciende con el entorno y el filtro", async () => {
    const { startBrowserErrorReporting } = await import("./browser");
    browserEnv.publicEnv = { appEnv: "staging", sentryDsn: DSN };

    startBrowserErrorReporting();

    expect(sentry.init).toHaveBeenCalledWith({
      dsn: DSN,
      environment: "staging",
      dataCollection: DATA_COLLECTION,
      beforeSend: expect.any(Function),
      integrations: expect.any(Function),
    });
  });

  // Por omisión el navegador le avisa a Sentry de cada visita, haya error o no, para
  // calcular qué porcentaje de visitas falla. Eso no es un error: no sale.
  it("no avisa de cada visita: quita el conteo de sesiones y deja lo demás", async () => {
    const { startBrowserErrorReporting } = await import("./browser");
    browserEnv.publicEnv = { appEnv: "staging", sentryDsn: DSN };

    startBrowserErrorReporting();

    const { integrations } = sentry.init.mock.calls[0]?.[0] as {
      integrations: (defaults: { name: string }[]) => { name: string }[];
    };
    expect(
      integrations([{ name: "GlobalHandlers" }, { name: "BrowserSession" }, { name: "Dedupe" }]),
    ).toEqual([{ name: "GlobalHandlers" }, { name: "Dedupe" }]);
  });

  it("reporta un error que atrapó una pantalla", async () => {
    const { captureBrowserError } = await import("./browser");
    const error = new Error("falló el reproductor");

    captureBrowserError(error);

    expect(sentry.captureException).toHaveBeenCalledWith(error);
  });
});
