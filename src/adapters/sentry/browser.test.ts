// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_COLLECTION } from "./options";

// Sentry en el navegador pesa, y casi ninguna visita lo necesita. Por eso no viaja con la
// página: se pide cuando el navegador queda libre, o en el momento en que hay un error
// que reportar. Estas pruebas cuidan las dos cosas que eso podría romper: que un error
// temprano no se pierda, y que el filtro siga puesto.

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

const browserEnv = vi.hoisted(() => ({
  publicEnv: {} as { appEnv?: string; sentryDsn?: string },
}));
vi.mock("@/config/public-env", () => browserEnv);

const DSN = ["https://clave-publica", "o1.ingest.sentry.example/1"].join("@");

// El módulo recuerda si ya pidió el SDK: cada prueba lo carga de nuevo.
async function freshAdapter() {
  vi.resetModules();
  return import("./browser");
}

// El DOM simulado no avisa cuándo queda libre: el adaptador espera dos segundos.
async function untilLoaded() {
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(sentry.init).toHaveBeenCalled());
}

function throwInPage(error: Error) {
  window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  browserEnv.publicEnv = { appEnv: "staging", sentryDsn: DSN };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Sentry en el navegador", () => {
  it("sin dirección no se pide, ni al arrancar ni al reportar", async () => {
    browserEnv.publicEnv = {};
    const { captureBrowserError, startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    captureBrowserError(new Error("x"));
    await vi.runAllTimersAsync();

    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("no se pide al arrancar, sino cuando el navegador queda libre", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    await Promise.resolve();
    expect(sentry.init).not.toHaveBeenCalled();

    await untilLoaded();
    expect(sentry.init).toHaveBeenCalledExactlyOnceWith({
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
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    await untilLoaded();

    const { integrations } = sentry.init.mock.calls[0]?.[0] as {
      integrations: (defaults: { name: string }[]) => { name: string }[];
    };
    expect(
      integrations([{ name: "GlobalHandlers" }, { name: "BrowserSession" }, { name: "Dedupe" }]),
    ).toEqual([{ name: "GlobalHandlers" }, { name: "Dedupe" }]);
  });

  it("un error que ocurre antes de que llegue el SDK no se pierde", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();
    const early = new Error("falló al cobrar vida la página");
    const rejected = new Error("promesa sin atender");

    startBrowserErrorReporting();
    throwInPage(early);
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: rejected }));
    expect(sentry.captureException).not.toHaveBeenCalled();

    await untilLoaded();
    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledTimes(2));
    expect(sentry.captureException).toHaveBeenNthCalledWith(1, early);
    expect(sentry.captureException).toHaveBeenNthCalledWith(2, rejected);
  });

  it("cuando el SDK ya llegó, deja de guardar: de ahí en adelante atrapa él", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    await untilLoaded();
    throwInPage(new Error("después de cargar"));
    await vi.runAllTimersAsync();

    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("guarda pocos: una página que falla en bucle no llena la memoria", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    for (let i = 0; i < 50; i += 1) throwInPage(new Error(`fallo ${i}`));

    await untilLoaded();
    await vi.runAllTimersAsync();
    expect(sentry.captureException).toHaveBeenCalledTimes(10);
  });

  it("un error que atrapó una pantalla pide el SDK en ese momento y lo reporta", async () => {
    const { captureBrowserError } = await freshAdapter();
    const error = new Error("falló el reproductor");

    captureBrowserError(error);

    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledExactlyOnceWith(error));
    expect(sentry.init).toHaveBeenCalledOnce();
  });

  it("el SDK se pide y se enciende una sola vez, lo pida quien lo pida", async () => {
    const { captureBrowserError, startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    captureBrowserError(new Error("uno"));
    captureBrowserError(new Error("dos"));

    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledTimes(2));
    await vi.runAllTimersAsync();
    expect(sentry.init).toHaveBeenCalledOnce();
  });
});
