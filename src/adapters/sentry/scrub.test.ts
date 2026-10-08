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
    expect(clean.exception?.values?.[0]?.value).toBe("Key (email)=([valor]) already exists.");
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

// Lo que encontró la revisión independiente: caminos por los que un dato salía aunque el
// filtro estuviera puesto. El revisor corrió el filtro con cada uno de estos y salían
// intactos.
describe("scrubEvent: lo que se le escapaba", () => {
  it("la ruta que Next anota en cada error del servidor sale sin sus parámetros", () => {
    const clean = scrubEvent(
      event({
        contexts: {
          nextjs: {
            request_path: "/cuenta/verificar?token_hash=abc123&correo=ana%40correo.com",
            router_path: "/cuenta/verificar",
            router_kind: "App Router",
            route_type: "route",
          },
        },
      }),
    );

    expect(clean.contexts?.nextjs).toEqual({
      request_path: "/cuenta/verificar",
      router_path: "/cuenta/verificar",
      router_kind: "App Router",
      route_type: "route",
    });
  });

  it("una ruta relativa dentro de un texto también pierde sus parámetros", () => {
    const clean = scrubEvent(
      event({ message: "GET /api/pagos?rfc=XAXX010101000&session=cs_live_a1b2c3d4e5f6 respondió 500" }),
    );

    expect(clean.message).toBe("GET /api/pagos respondió 500");
  });

  it.each([
    ["un correo codificado en una dirección", "aviso a ana%40correo.com", "aviso a [correo]"],
    ["un correo con eñe en el dominio", "aviso a ana@niño.mx", "aviso a [correo]"],
    ["un correo con eñe en el nombre", "aviso a peña@correo.com", "aviso a [correo]"],
    ["un correo en mayúsculas", "aviso a ANA.PEREZ@CORREO.COM", "aviso a [correo]"],
    [
      "un token de sesión",
      "token eyJhbGciOiJFUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhbmEiLCJleHAiOjF9.c2lnbmF0dXJhLWRlLXBydWViYQ rechazado",
      "token [token] rechazado",
    ],
    ["una llave de Stripe", "llave sk_live_51Hx9aBcDeFgHiJkLmNoP inválida", "llave [llave] inválida"],
    ["una sesión de cobro", "sesión cs_test_a1B2c3D4e5F6g7H8 vencida", "sesión [llave] vencida"],
    ["una llave de Supabase", "llave sb_secret_AbCdEfGhIjKlMnOp inválida", "llave [llave] inválida"],
    ["un teléfono de diez dígitos", "llamar al 5512345678 mañana", "llamar al [número] mañana"],
    ["un teléfono con lada y espacios", "llamar al +52 55 1234 5678 mañana", "llamar al [número] mañana"],
    ["un RFC de persona", "el RFC GODE561231GR8 no coincide", "el RFC [rfc] no coincide"],
    ["un RFC genérico", "el RFC XAXX010101000 no coincide", "el RFC [rfc] no coincide"],
    ["una CURP", "la CURP GODE561231HDFRRN04 no coincide", "la CURP [curp] no coincide"],
    [
      "una cadena de conexión con contraseña",
      ["no conecta a postgresql://app_service", "S3creta@db.example:5432/postgres"].join(":"),
      "no conecta a postgresql://[credenciales]@db.example:5432/postgres",
    ],
    [
      "el valor que chocó en la base",
      "duplicate key: Key (rfc)=(XAXX010101000) already exists.",
      "duplicate key: Key (rfc)=([valor]) already exists.",
    ],
    [
      "la fila que rechazó la base",
      "Failing row contains (7, Ana Pérez, ana, 1990-01-01).",
      "Failing row contains ([fila]).",
    ],
  ])("enmascara %s", (_name, text, expected) => {
    const clean = scrubEvent(
      event({
        message: text,
        exception: { values: [{ type: "Error", value: text }] },
        breadcrumbs: [{ category: "fetch", message: text }],
      }),
    );

    expect(clean.message).toBe(expected);
    expect(clean.exception?.values?.[0]?.value).toBe(expected);
    expect(clean.breadcrumbs?.[0]?.message).toBe(expected);
  });

  it.each([
    "name",
    "username",
    "userName",
    "apellido",
    "apellidos",
    "clave",
    "llave",
    "clabe",
    "ip",
    "ip_address",
    "jwt",
    "session",
    "sessionId",
    "card",
    "tarjeta",
    "domicilio",
    "cuenta",
    "iban",
    "nacimiento",
  ])("filtra también la clave «%s» donde las claves las pone nuestro código", (key) => {
    const clean = scrubEvent(
      event({
        extra: { [key]: "dato de una persona", intento: 3 },
        tags: { [key]: "dato de una persona" },
        contexts: { cobro: { [key]: "dato de una persona", plan: "mensual" } },
        breadcrumbs: [{ category: "ui", data: { [key]: "dato de una persona" } }],
      }),
    );

    expect(asText(clean)).not.toContain("dato de una persona");
    expect(clean.extra).toEqual({ [key]: "[filtrado]", intento: 3 });
    expect(clean.contexts?.cobro).toEqual({ [key]: "[filtrado]", plan: "mensual" });
  });

  it("no filtra por nombre lo que el propio SDK anota del entorno: de qué máquina y qué programa", () => {
    const sdkContexts = {
      runtime: { name: "node", version: "v24.11.0" },
      os: { name: "Linux", kernel_version: "5.10" },
      browser: { name: "Firefox", version: "140" },
      device: { arch: "x64", processor_count: 2 },
      app: { app_start_time: "2026-10-08T14:40:12.350Z" },
      culture: { locale: "es-MX", timezone: "UTC" },
      cloud_resource: { "cloud.provider": "vercel", "cloud.region": "iad1" },
      react: { version: "19.3.0" },
      trace: { trace_id: "bec22f59c14f4bfcbeb7338040b99383", span_id: "9405eecee1b592e7" },
    };

    expect(scrubEvent(event({ contexts: sdkContexts })).contexts).toEqual(sdkContexts);
  });

  it("de la persona solo pasa un identificador opaco: un correo puesto ahí no pasa", () => {
    expect(scrubEvent(event({ user: { id: "ana@correo.com" } })).user).toBeUndefined();
    expect(scrubEvent(event({ user: { id: 42 } })).user).toBeUndefined();
    expect(
      scrubEvent(event({ user: { id: "5B1F0C1E-0000-4000-8000-000000000001" } })).user,
    ).toEqual({ id: "5B1F0C1E-0000-4000-8000-000000000001" });
  });

  // La base repite en su mensaje lo que no pudo leer. Un texto así de largo hacía tardar
  // diez segundos al filtro, con el servidor detenido mientras tanto.
  it("un texto enorme se recorta antes de revisarlo, y no detiene al servidor", () => {
    const huge = `invalid input syntax for type uuid: "${"a".repeat(80_000)}"`;
    const started = performance.now();
    const clean = scrubEvent(
      event({ message: huge, exception: { values: [{ type: "Error", value: huge }] } }),
    );

    expect(performance.now() - started).toBeLessThan(500);
    expect(clean.message?.length).toBeLessThan(2_100);
    expect(clean.message).toContain("[recortado]");
    expect(clean.exception?.values?.[0]?.value?.length).toBeLessThan(2_100);
  });

  it("si hasta el respaldo falla, sale un aviso sin nada del evento, no un error", () => {
    const hostile = new Proxy(event({ message: "ana@correo.com" }), {
      get() {
        throw new Error("no se puede leer nada");
      },
      ownKeys() {
        throw new Error("no se puede leer nada");
      },
    });

    const clean = scrubEvent(hostile);

    expect(asText(clean)).not.toContain("correo.com");
    expect(clean.tags).toEqual({ filtro_fallido: "dos veces" });
    expect(clean.level).toBe("error");
  });
});

