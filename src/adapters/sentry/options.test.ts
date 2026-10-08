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
      user: { id: "1", email: "ana@correo.com" },
    };

    expect(options.beforeSend(event)).toEqual({
      type: undefined,
      message: "[correo]",
      user: { id: "1" },
    });
  });

  it("solo errores: sin trazas, sin registros y sin grabar sesiones", () => {
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("enableLogs");
    expect(options).not.toHaveProperty("replaysSessionSampleRate");
    expect(options).not.toHaveProperty("replaysOnErrorSampleRate");
    expect(options).not.toHaveProperty("integrations");
  });
});
