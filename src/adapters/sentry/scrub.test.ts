import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";

import { scrubEvent } from "./scrub";

// El TRD (secciones 9.10 y 10.5) dice que a Sentry llegan errores sin datos personales.
// Esta prueba es lo que lo sostiene: cada caso es un lugar del evento por donde un dato
// de una persona podría salir.

const event = (parts: Partial<ErrorEvent>): ErrorEvent => ({ type: undefined, ...parts });

const asText = (value: unknown) => JSON.stringify(value);

describe("scrubEvent", () => {
  it("de la persona deja solo su identificador", () => {
    const clean = scrubEvent(
      event({
        user: {
          id: "5b1f0c1e-0000-4000-8000-000000000001",
          email: "ana@correo.com",
          username: "Ana Pérez",
          ip_address: "189.203.10.4",
          geo: { city: "Puebla", country_code: "MX" },
        },
      }),
    );

    expect(clean.user).toEqual({ id: "5b1f0c1e-0000-4000-8000-000000000001" });
  });

  it("si la persona no trae identificador, no manda nada de ella", () => {
    const clean = scrubEvent(event({ user: { email: "ana@correo.com", ip_address: "{{auto}}" } }));

    expect(clean.user).toBeUndefined();
  });

  it("de la petición deja el método y la dirección, sin parámetros", () => {
    const clean = scrubEvent(
      event({
        request: {
          method: "POST",
          url: "https://plataforma.example/cuenta/verificar?token_hash=abc123&type=email#paso",
          query_string: "token_hash=abc123&type=email",
          cookies: { "sb-access-token": "eyJ..." },
          headers: { authorization: "Bearer eyJ...", "user-agent": "Mozilla/5.0" },
          data: { email: "ana@correo.com", password: "secreta" },
          env: { REMOTE_ADDR: "189.203.10.4" },
        },
      }),
    );

    expect(clean.request).toEqual({
      method: "POST",
      url: "https://plataforma.example/cuenta/verificar",
    });
  });

  it("enmascara un correo dentro del mensaje de un error", () => {
    const clean = scrubEvent(
      event({
        message: "No se pudo avisar a ana.perez+cursos@correo.com.mx",
        logentry: { message: "Fallo para %s", params: ["ana@correo.com"] },
        exception: {
          values: [
            {
              type: "DatabaseError",
              value: "Key (email)=(ana@correo.com) already exists.",
            },
          ],
        },
      }),
    );

    expect(asText(clean)).not.toContain("correo.com");
    expect(clean.message).toBe("No se pudo avisar a [correo]");
    expect(clean.exception?.values?.[0]?.value).toBe("Key (email)=([correo]) already exists.");
    expect(clean.exception?.values?.[0]?.type).toBe("DatabaseError");
  });

  it("no confunde con un correo la versión de un paquete", () => {
    const clean = scrubEvent(
      event({
        message: "Falló sentry+core@11.5.0 al cargar app@1.0.0 y next@16.3.8_react@19.3.0",
      }),
    );

    expect(clean.message).toBe(
      "Falló sentry+core@11.5.0 al cargar app@1.0.0 y next@16.3.8_react@19.3.0",
    );
  });

  it("quita los parámetros de toda dirección: en las migas y dentro de un texto", () => {
    const clean = scrubEvent(
      event({
        message: "Falló GET https://api.example/v1/personas?correo=ana&pagina=2 con 500",
        breadcrumbs: [
          {
            category: "navigation",
            data: { from: "/buscar?q=ansiedad", to: "/restablecer?token=abc123#inicio" },
          },
          {
            category: "fetch",
            data: { method: "GET", url: "https://api.example/v1/cursos?alumno=42", status_code: 500 },
          },
        ],
      }),
    );

    expect(clean.message).toBe("Falló GET https://api.example/v1/personas con 500");
    expect(clean.breadcrumbs?.[0]?.data).toEqual({ from: "/buscar", to: "/restablecer" });
    expect(clean.breadcrumbs?.[1]?.data).toEqual({
      method: "GET",
      url: "https://api.example/v1/cursos",
      status_code: 500,
    });
  });

  it("enmascara un correo escrito en la consola, que llega como miga", () => {
    const clean = scrubEvent(
      event({
        breadcrumbs: [{ category: "console", message: "sesión de ana@correo.com", level: "info" }],
      }),
    );

    expect(clean.breadcrumbs?.[0]).toEqual({
      category: "console",
      message: "sesión de [correo]",
      level: "info",
    });
  });

  it.each([
    "password",
    "contrasena",
    "contraseña",
    "token",
    "access_token",
    "secret",
    "authorization",
    "cookie",
    "apiKey",
    "email",
    "correo",
    "telefono",
    "teléfono",
    "phone",
    "nombre",
    "fullName",
    "rfc",
    "curp",
    "direccion",
    "dirección",
  ])("filtra por su nombre la clave «%s», venga donde venga", (key) => {
    const clean = scrubEvent(
      event({
        extra: { [key]: "dato de una persona", intento: 3 },
        contexts: { cuenta: { anidado: { [key]: "dato de una persona" }, plan: "mensual" } },
        tags: { [key]: "dato de una persona" },
        breadcrumbs: [{ category: "ui", data: { [key]: "dato de una persona" } }],
      }),
    );

    expect(asText(clean)).not.toContain("dato de una persona");
    expect(clean.extra).toEqual({ [key]: "[filtrado]", intento: 3 });
    expect(clean.contexts?.cuenta).toEqual({ anidado: { [key]: "[filtrado]" }, plan: "mensual" });
  });

  it("conserva lo que sirve para diagnosticar", () => {
    const original = event({
      event_id: "c0ffee",
      level: "error",
      platform: "node",
      environment: "staging",
      release: "4707191299e8",
      transaction: "GET /api/cursos/[id]",
      server_name: "iad1",
      tags: { runtime: "nodejs", zona: "cobro" },
      contexts: { runtime: { name: "node", version: "v24.11.0" } },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            mechanism: { type: "generic", handled: false },
            stacktrace: {
              frames: [
                {
                  filename: "app:///src/services/cursos.ts",
                  function: "obtenerCurso",
                  lineno: 42,
                  colno: 7,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    });

    expect(scrubEvent(original)).toEqual(original);
  });

  it("no cambia el evento que recibe", () => {
    const original = event({
      message: "ana@correo.com",
      user: { id: "1", email: "ana@correo.com" },
      extra: { token: "abc" },
    });
    const copy = structuredClone(original);

    scrubEvent(original);

    expect(original).toEqual(copy);
  });

  it("si el filtro falla, manda el error sin un solo texto libre", () => {
    const trap = {};
    Object.defineProperty(trap, "boom", {
      enumerable: true,
      get() {
        throw new Error("no se puede leer");
      },
    });

    const clean = scrubEvent(
      event({
        event_id: "c0ffee",
        environment: "staging",
        message: "ana@correo.com",
        user: { id: "1", email: "ana@correo.com" },
        extra: trap,
        exception: {
          values: [
            {
              type: "TypeError",
              value: "ana@correo.com no existe",
              stacktrace: { frames: [{ filename: "app:///src/a.ts", lineno: 1 }] },
            },
          ],
        },
      }),
    );

    expect(asText(clean)).not.toContain("correo.com");
    expect(clean.event_id).toBe("c0ffee");
    expect(clean.environment).toBe("staging");
    expect(clean.tags).toEqual({ filtro_fallido: "si" });
    expect(clean.exception?.values?.[0]).toEqual({
      type: "TypeError",
      stacktrace: { frames: [{ filename: "app:///src/a.ts", lineno: 1 }] },
    });
  });
});
