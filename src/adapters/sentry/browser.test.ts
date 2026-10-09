// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_COLLECTION } from "./options";

// Sentry en el navegador pesa, y casi ninguna visita lo necesita. Por eso no viaja con la
// página: se pide cuando el navegador queda libre, o en el momento en que hay un error
// que reportar. Estas pruebas cuidan las dos cosas que eso podría romper: que un error
// temprano no se pierda, y que el filtro siga puesto.

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  breadcrumbsIntegration: vi.fn((options: unknown) => ({ name: "Breadcrumbs", options })),
  makeFetchTransport: vi.fn(() => ({ send: fetchSend, flush: vi.fn() })),
}));
const fetchSend = vi.hoisted(() => vi.fn(async () => ({})));
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
    expect(sentry.init).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        dsn: DSN,
        environment: "staging",
        dataCollection: DATA_COLLECTION,
        beforeSend: expect.any(Function),
        integrations: expect.any(Function),
      }),
    );
    expect(sentry.init.mock.calls[0]?.[0]).not.toHaveProperty("tracesSampleRate");
  });

  // Una lista de lo que se queda, no de lo que se quita. Por omisión el navegador le
  // avisa a Sentry de cada visita, mide la navegación, guarda la consola y anota el
  // idioma y la zona horaria de la persona; y cada versión del SDK agrega alguna más.
  it("solo las integraciones conocidas: una nueva del SDK no entra sola", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    await untilLoaded();

    const { integrations } = sentry.init.mock.calls[0]?.[0] as {
      integrations: (defaults: { name: string }[]) => { name: string; options?: unknown }[];
    };
    const result = integrations([
      { name: "EventFilters" },
      { name: "FunctionToString" },
      { name: "ConversationId" },
      { name: "BrowserApiErrors" },
      { name: "Breadcrumbs" },
      { name: "Console" },
      { name: "GlobalHandlers" },
      { name: "LinkedErrors" },
      { name: "Dedupe" },
      { name: "HttpContext" },
      { name: "CultureContext" },
      { name: "BrowserSession" },
      { name: "BrowserTracing" },
      { name: "NextjsClientStackFrameNormalization" },
      { name: "AlgoQueAgregaLaVersionQueViene" },
    ]);
    expect(result.map(({ name }) => name)).toEqual([
      "EventFilters",
      "FunctionToString",
      "BrowserApiErrors",
      "GlobalHandlers",
      "LinkedErrors",
      "Dedupe",
      "HttpContext",
      "NextjsClientStackFrameNormalization",
      "Breadcrumbs",
    ]);
    // El rastro vuelve sin los clics, que llevan el `aria-label` y el `title` de lo que
    // se pulsó («Continuar: Duelo y ansiedad» es un dato de quien toma ese curso), y sin
    // la lista de eventos anteriores, que repite sus mensajes.
    expect(result.at(-1)?.options).toEqual({ dom: false, sentry: false });
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
    // Nadie los atrapó: van marcados así, para que en Sentry no pasen por errores menores.
    // Con el mismo nombre que les pone el SDK cuando los atrapa él: el mismo error no
    // debe verse distinto según si llegó antes o después de que el SDK cargara.
    expect(sentry.captureException).toHaveBeenNthCalledWith(1, early, {
      mechanism: { type: "auto.browser.global_handlers.onerror", handled: false },
    });
    expect(sentry.captureException).toHaveBeenNthCalledWith(2, rejected, {
      mechanism: { type: "auto.browser.global_handlers.onunhandledrejection", handled: false },
    });
  });

  // Quien ve fallar la página suele irse. Si el SDK esperara su turno, ese error se
  // perdería con la pestaña.
  it("el primer error temprano pide el SDK en ese momento, sin esperar a que el navegador quede libre", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    throwInPage(new Error("falló al cobrar vida la página"));

    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalled());
    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledOnce());
  });

  it("le pone tiempo máximo a la espera: en una pestaña de fondo el reposo puede no llegar nunca", async () => {
    const requestIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    try {
      const { startBrowserErrorReporting } = await freshAdapter();
      startBrowserErrorReporting();
      expect(requestIdleCallback).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        timeout: 2_000,
      });
      // El reposo llega: el SDK carga y quita sus oyentes, para no dejarlos puestos.
      (requestIdleCallback.mock.calls[0]?.[0] as () => void)();
      await vi.waitFor(() => expect(sentry.init).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Una pestaña abierta durante un despliegue pide un pedazo que ya no existe. Si ese
  // fallo se recordara, esa pestaña no volvería a reportar nada.
  it("si el SDK no llega, el siguiente error lo vuelve a pedir", async () => {
    const { captureBrowserError } = await freshAdapter();
    sentry.init.mockImplementationOnce(() => {
      throw new Error("el pedazo ya no existe");
    });

    captureBrowserError(new Error("uno"));
    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalledOnce());
    const second = new Error("dos");
    captureBrowserError(second);

    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledWith(second));
    expect(sentry.init).toHaveBeenCalledTimes(2);
  });

  it("lo que sale pasa por un transporte que solo deja pasar errores", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    await untilLoaded();

    const { transport } = sentry.init.mock.calls[0]?.[0] as {
      transport: (options: unknown) => { send: (envelope: unknown) => Promise<unknown> };
    };
    const { send } = transport({});
    await send([{}, [[{ type: "session" }, {}], [{ type: "feedback" }, {}]]]);
    expect(fetchSend).not.toHaveBeenCalled();

    await send([{}, [[{ type: "event" }, {}]]]);
    expect(fetchSend).toHaveBeenCalledOnce();
  });

  // Pero no para siempre. Con un bloqueador, el SDK no va a llegar nunca: una página que
  // falla en bucle no debe pedirlo a la red una vez por cada error.
  it("si el SDK no llega en tres intentos, deja de pedirlo y de escuchar", async () => {
    const { captureBrowserError, startBrowserErrorReporting } = await freshAdapter();
    sentry.init.mockImplementation(() => {
      throw new Error("bloqueado");
    });

    try {
      startBrowserErrorReporting();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        captureBrowserError(new Error(`intento ${attempt}`));
        await vi.waitFor(() => expect(sentry.init).toHaveBeenCalledTimes(attempt));
        await vi.advanceTimersByTimeAsync(0);
      }
      captureBrowserError(new Error("cuarto"));
      await vi.runAllTimersAsync();

      expect(sentry.init).toHaveBeenCalledTimes(3);
      expect(sentry.captureException).not.toHaveBeenCalled();

      // Y ya no guarda: nadie se los va a pedir. El oyente de la prueba hace las veces de
      // quien atiende el error, para que Vitest no lo dé por fallo.
      const pageListener = vi.fn();
      window.addEventListener("error", pageListener);
      throwInPage(new Error("después de rendirse"));
      await vi.runAllTimersAsync();
      window.removeEventListener("error", pageListener);
      expect(sentry.init).toHaveBeenCalledTimes(3);
    } finally {
      sentry.init.mockReset();
    }
  });

  it("si una pantalla pidió el SDK antes del reposo, lo guardado se entrega una sola vez", async () => {
    const { captureBrowserError, startBrowserErrorReporting } = await freshAdapter();
    const early = new Error("temprano");
    const sdkListener = vi.fn();
    sentry.init.mockImplementationOnce(() => window.addEventListener("error", sdkListener));

    startBrowserErrorReporting();
    throwInPage(early);
    captureBrowserError(new Error("de una pantalla"));
    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledTimes(2));
    await untilLoaded();
    throwInPage(new Error("ya con el SDK"));
    await vi.runAllTimersAsync();
    window.removeEventListener("error", sdkListener);

    expect(sentry.captureException).toHaveBeenCalledTimes(2);
    expect(sdkListener).toHaveBeenCalledOnce();
  });

  it("cuando el SDK ya llegó, deja de guardar: de ahí en adelante atrapa él", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();
    // El SDK de verdad pone su propio oyente al encenderse. Este hace sus veces: sin
    // ninguno, el error de la prueba quedaría sin atender y Vitest lo daría por fallo.
    const sdkListener = vi.fn();
    sentry.init.mockImplementationOnce(() => window.addEventListener("error", sdkListener));

    startBrowserErrorReporting();
    await untilLoaded();
    throwInPage(new Error("después de cargar"));
    await vi.runAllTimersAsync();
    window.removeEventListener("error", sdkListener);

    expect(sdkListener).toHaveBeenCalledOnce();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("guarda pocos: una página que falla en bucle no llena la memoria", async () => {
    const { startBrowserErrorReporting } = await freshAdapter();

    startBrowserErrorReporting();
    for (let i = 0; i < 50; i += 1) throwInPage(new Error(`fallo ${i}`));

    await vi.waitFor(() => expect(sentry.init).toHaveBeenCalled());
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
