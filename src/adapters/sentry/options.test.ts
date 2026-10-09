import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";

import { buildOptions, DATA_COLLECTION } from "./options";
import { SCAN_WINDOW } from "./scrub";

// Desde la versión 11 del SDK, lo que se recolecta por omisión es todo: cabeceras,
// cookies, cuerpos, parámetros, datos de la persona. Aquí se apaga, categoría por
// categoría, y esta prueba falla si alguna se vuelve a prender.

describe("lo que el SDK recolecta por su cuenta", () => {
  it("nada que pueda traer un dato de una persona", () => {
    expect(DATA_COLLECTION).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
  });
});

describe("buildOptions", () => {
  const options = buildOptions({ dsn: "https://clave@o1.ingest.sentry.example/1", environment: "staging" });

  it("manda a donde se le dice, con el nombre del entorno", () => {
    expect(options.dsn).toBe("https://clave@o1.ingest.sentry.example/1");
    expect(options.environment).toBe("staging");
  });

  it("apaga la recolección automática", () => {
    expect(options.dataCollection).toBe(DATA_COLLECTION);
  });

  it("pasa cada error por el filtro antes de mandarlo", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "ana@correo.com",
      user: { id: "5b1f0c1e-0000-4000-8000-000000000001", email: "ana@correo.com" },
    };

    expect(options.beforeSend(event)).toEqual({
      type: undefined,
      message: "[correo]",
      user: { id: "5b1f0c1e-0000-4000-8000-000000000001" },
    });
  });

  // Un cero no es lo mismo que nada: para el SDK, una tasa de trazas definida, aunque sea
  // cero, es «trazas prendidas». Con eso instala decenas de integraciones, parchea el
  // cliente de la base y manda avisos de lo que descartó. Aquí la tasa no se define. Que
  // nadie la defina desde una variable de entorno lo cuida `src/config/env.ts`.
  it("solo errores: la tasa de trazas no se define, ni siquiera en cero", () => {
    expect(options).not.toHaveProperty("tracesSampleRate");
  });

  // En el modo por omisión («stream») las trazas salen por partes, sin pasar por
  // `beforeSendTransaction`. En el modo estático sí pasan, y ahí se detienen.
  it("solo errores: si algo prendiera las trazas, no saldrían", () => {
    expect(options.traceLifecycle).toBe("static");
    expect(options.beforeSendTransaction()).toBeNull();
  });

  it("solo errores: ni registros ni métricas salen, aunque algo los prenda", () => {
    expect(options.enableLogs).toBe(false);
    expect(options.beforeSendLog()).toBeNull();
    expect(options.beforeSendMetric()).toBeNull();
  });

  // El SDK le avisa a Sentry de cuántos eventos descartó y por qué. No es un error.
  it("solo errores: sin el aviso de lo que se descartó", () => {
    expect(options.sendClientReports).toBe(false);
  });

  it("no le manda cabeceras de rastreo a nadie: ni a la base, ni a cobros, ni al video", () => {
    expect(options.tracePropagationTargets).toEqual([]);
  });

  // El SDK corta antes de que el filtro vea el texto, y corta a ciegas: puede dejar medio
  // correo, sin la forma completa con que el filtro lo reconoce. Por eso su tope queda
  // más allá de lo que el filtro revisa: el corte que cuenta es el del filtro.
  it("le pone tope a los textos, pero más allá de lo que el filtro revisa", () => {
    expect(options.maxValueLength).toBe(8_000);
    expect(options.maxValueLength).toBeGreaterThan(SCAN_WINDOW);
  });

  it("sin grabación de sesiones", () => {
    expect(options).not.toHaveProperty("replaysSessionSampleRate");
    expect(options).not.toHaveProperty("replaysOnErrorSampleRate");
  });
});
