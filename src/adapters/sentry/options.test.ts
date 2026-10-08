import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";

import { buildOptions, DATA_COLLECTION } from "./options";

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

  // No basta con no pedirlas. El SDK lee por su cuenta la variable
  // SENTRY_TRACES_SAMPLE_RATE: si alguien la pusiera en Vercel prendería las trazas, y
  // las trazas no pasan por `beforeSend`. Aquí se apagan dichas, y con su propia puerta.
  it("solo errores: las trazas van apagadas de forma explícita", () => {
    expect(options.tracesSampleRate).toBe(0);
    expect(options.beforeSendTransaction()).toBeNull();
  });

  it("solo errores: ni registros ni métricas salen, aunque algo los prenda", () => {
    expect(options.enableLogs).toBe(false);
    expect(options.beforeSendLog()).toBeNull();
    expect(options.beforeSendMetric()).toBeNull();
  });

  it("no le manda cabeceras de rastreo a nadie: ni a la base, ni a cobros, ni al video", () => {
    expect(options.tracePropagationTargets).toEqual([]);
  });

  it("recorta los textos largos antes de mandarlos", () => {
    expect(options.maxValueLength).toBe(2_000);
  });

  it("sin grabación de sesiones", () => {
    expect(options).not.toHaveProperty("replaysSessionSampleRate");
    expect(options).not.toHaveProperty("replaysOnErrorSampleRate");
  });
});
