import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_COLLECTION } from "./options";

// Encender Sentry es lo único que este archivo hace. Lo que importa comprobar: que sin
// dirección no se enciende, y que cuando se enciende lleva las opciones del filtro.

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRequestError: vi.fn(),
  httpIntegration: vi.fn((options: unknown) => ({ name: "Http", options })),
  makeNodeTransport: vi.fn(() => ({ send: nodeSend, flush: vi.fn() })),
}));
const nodeSend = vi.hoisted(() => vi.fn(async () => ({})));
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
        integrations: expect.any(Function),
      }),
    );
    expect(sentry.init.mock.calls[0]?.[0]).not.toHaveProperty("tracesSampleRate");
  });

  // El SDK lee por su cuenta la variable SENTRY_SPOTLIGHT, y con ella manda una copia de
  // cada evento a otra dirección, la que diga la variable. Dicho aquí, la variable no cuenta.
  it("no manda copia de los eventos a ningún otro lado, lo diga quien lo diga", () => {
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };

    startServerErrorReporting();

    expect(sentry.init.mock.calls[0]?.[0]).toMatchObject({ spotlight: false });
  });

  // Una lista de lo que se queda, no de lo que se quita: el SDK trae de fábrica dos
  // docenas de integraciones y cada versión agrega alguna. Con una lista de prohibidas,
  // la nueva entraría prendida sin que nadie la viera.
  it("solo las integraciones conocidas: una nueva del SDK no entra sola", () => {
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };
    startServerErrorReporting();

    const { integrations } = sentry.init.mock.calls[0]?.[0] as {
      integrations: (defaults: { name: string }[]) => { name: string; options?: unknown }[];
    };
    const result = integrations([
      { name: "EventFilters" },
      { name: "FunctionToString" },
      { name: "LinkedErrors" },
      { name: "Dedupe" },
      { name: "RequestData" },
      { name: "NodeSystemError" },
      // Las que mandan algo más que errores, o parchean lo que no deben:
      { name: "ConversationId" },
      { name: "Console" },
      { name: "NodeFetch" },
      { name: "OnUncaughtException" },
      { name: "OnUnhandledRejection" },
      { name: "ContextLines" },
      { name: "LocalVariablesAsync" },
      { name: "Context" },
      { name: "ChildProcess" },
      { name: "WorkerThreads" },
      { name: "ProcessSession" },
      { name: "Modules" },
      { name: "Postgres" },
      { name: "Http" },
      { name: "DistDirRewriteFrames" },
      { name: "NextjsUseCache" },
      // Y una que todavía no existe.
      { name: "AlgoQueAgregaLaVersionQueViene" },
    ]);

    expect(result.map(({ name }) => name)).toEqual([
      "EventFilters",
      "FunctionToString",
      "LinkedErrors",
      "Dedupe",
      "RequestData",
      "NodeSystemError",
      "OnUncaughtException",
      "OnUnhandledRejection",
      "Context",
      "DistDirRewriteFrames",
      "Http",
    ]);
  });

  // ContextLines abre cada archivo que la pila nombre y manda sus líneas. Y la pila sale
  // del texto del error: un mensaje con un salto de línea y «at x (/ruta:1:1)» le hacía
  // abrir esa ruta, fuera la que fuera. No se instala: Sentry muestra el código a partir
  // de los mapas que se suben al compilar.
  it("no instala la integración que lee archivos del disco", () => {
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };
    startServerErrorReporting();

    const { integrations } = sentry.init.mock.calls[0]?.[0] as {
      integrations: (defaults: { name: string }[]) => { name: string }[];
    };

    expect(integrations([{ name: "ContextLines" }]).map(({ name }) => name)).toEqual(["Http"]);
  });

  // La última puerta. Lo que no es un error (un aviso de trabajo programado, un
  // comentario de una persona, un archivo adjunto) no pasa por el filtro: sale por otro
  // camino. Aquí se descarta al salir, lo haya pedido quien lo haya pedido.
  it("lo que sale pasa por un transporte que solo deja pasar errores", async () => {
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };
    startServerErrorReporting();

    const { transport } = sentry.init.mock.calls[0]?.[0] as {
      transport: (options: unknown) => { send: (envelope: unknown) => Promise<unknown> };
    };
    const { send } = transport({});
    await send([{}, [[{ type: "check_in" }, {}]]]);
    expect(nodeSend).not.toHaveBeenCalled();

    await send([{}, [[{ type: "event" }, {}]]]);
    expect(nodeSend).toHaveBeenCalledOnce();
  });

  // La de `http` de fábrica cuenta cada petición (las sesiones), mide las que entran y
  // les pone cabeceras de rastreo a las que salen. Se vuelve a poner sin nada de eso:
  // queda lo que separa el contexto de una petición del de otra.
  it("la integración de http vuelve sin conteo, sin medición, sin rastro y sin cabeceras", () => {
    serverEnv.current = { APP_ENV: "staging", SENTRY_DSN: DSN };
    startServerErrorReporting();

    const { integrations } = sentry.init.mock.calls[0]?.[0] as {
      integrations: (defaults: { name: string }[]) => { name: string; options?: unknown }[];
    };
    const result = integrations([{ name: "Http" }]);

    expect(result).toHaveLength(1);
    expect(result[0]?.options).toEqual({
      disableIncomingRequestSpans: true,
      sessions: false,
      tracePropagation: false,
      breadcrumbs: false,
    });
  });

  it("reporta el error de una petición con la función del SDK", () => {
    expect(captureRequestError).toBe(sentry.captureRequestError);
  });
});
