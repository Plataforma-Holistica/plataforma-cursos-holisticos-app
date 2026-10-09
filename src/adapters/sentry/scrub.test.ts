import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";

import { scrubEvent } from "./scrub";

// El TRD (secciones 9.10 y 10.5) dice que a Sentry llegan errores sin datos personales.
// Esta prueba es lo que lo sostiene.
//
// El filtro no quita lo malo de un evento: arma uno nuevo solo con lo que conoce. Lo que
// no está en su lista no sale, sea lo que sea. Dos revisiones independientes mostraron
// por qué: a una lista de cosas prohibidas siempre le falta una (una clave que nadie
// previó, un campo nuevo del SDK, un objeto lanzado como error con todas sus claves).

const event = (parts: Partial<ErrorEvent>): ErrorEvent => ({ type: undefined, ...parts });
const asText = (value: unknown) => JSON.stringify(value);

const UUID = "5b1f0c1e-0000-4000-8000-000000000001";
const EVENT_ID = "c0ffee00000000000000000000000001";

describe("scrubEvent: lo que deja pasar", () => {
  it("lo que identifica al error y lo que sirve para diagnosticarlo", () => {
    const original = event({
      event_id: EVENT_ID,
      timestamp: 1_791_489_124,
      level: "error",
      platform: "node",
      environment: "staging",
      release: "4707191299e8",
      dist: "1",
      transaction: "GET /api/cursos/[id]",
      sdk: {
        name: "sentry.javascript.nextjs",
        version: "11.5.0",
        integrations: ["EventFilters", "Http"],
        packages: [{ name: "npm:@sentry/nextjs", version: "11.5.0" }],
        settings: { infer_ip: "never" },
      },
      debug_meta: { images: [{ type: "sourcemap", code_file: "app:///a.js", debug_id: UUID }] },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            mechanism: {
              type: "auto.function.nextjs.on_request_error",
              handled: false,
              // Lo que dice cuál excepción es causa de cuál, en un error con varias.
              exception_id: 1,
              parent_id: 0,
              is_exception_group: false,
              source: "errors[0]",
              synthetic: true,
            },
            stacktrace: {
              frames: [
                {
                  filename: "app:///src/services/cursos.ts",
                  abs_path: "/var/task/src/services/cursos.ts",
                  function: "obtenerCurso",
                  module: "cursos",
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

  it("de la persona, solo un identificador opaco", () => {
    const user = { id: UUID, email: "ana@correo.com", username: "Ana", ip_address: "189.203.10.4" };

    expect(scrubEvent(event({ user })).user).toEqual({ id: UUID });
    expect(scrubEvent(event({ user: { ...user, id: "ana@correo.com" } })).user).toBeUndefined();
    expect(scrubEvent(event({ user: { ...user, id: 42 } })).user).toBeUndefined();
    expect(scrubEvent(event({ user: { email: "ana@correo.com" } })).user).toBeUndefined();
  });

  it("de la petición, el método y la dirección sin parámetros", () => {
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

  it("de la pila, cada punto sin los parámetros de su dirección y sin variables", () => {
    const clean = scrubEvent(
      event({
        exception: {
          values: [
            {
              type: "Error",
              stacktrace: {
                frames: [
                  {
                    filename: "https://plataforma.example/cuenta/verificar?token_hash=SECRETO",
                    abs_path: "https://plataforma.example/cuenta/verificar?token_hash=SECRETO#x",
                    function: "onClick",
                    lineno: 1,
                    vars: { password: "secreta", curso: "Duelo" },
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(asText(clean)).not.toMatch(/SECRETO|secreta|Duelo/);
    expect(clean.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: "https://plataforma.example/cuenta/verificar",
      abs_path: "https://plataforma.example/cuenta/verificar",
      function: "onClick",
      lineno: 1,
    });
  });

  // El SDK del servidor abría cada archivo que nombrara la pila y mandaba sus líneas. Y
  // la pila sale del texto del error: un mensaje con un salto de línea y «at x (ruta:1:1)»
  // le hacía abrir esa ruta, fuera la que fuera. Las líneas de código ya no salen: Sentry
  // las muestra a partir de los mapas de código que se suben al compilar.
  it("de la pila, ninguna línea de código: ni la del punto ni las de alrededor", () => {
    const clean = scrubEvent(
      event({
        exception: {
          values: [
            {
              type: "Error",
              stacktrace: {
                frames: [
                  {
                    filename: "/var/task/.env",
                    lineno: 2,
                    pre_context: ["SUPABASE_SECRET_KEY=sb_secret_AbCdEfGhIjKlMnOp"],
                    context_line: "PACIENTE=Ana Godinez",
                    post_context: ["OTRA=cosa"],
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(clean.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: "/var/task/.env",
      lineno: 2,
    });
  });

  // El SDK arma la pila leyendo el texto del error, y toma por un punto de la pila cada
  // línea del mensaje que se le parezca. Lo que venía en el mensaje aparece entonces como
  // nombre de archivo, de función o de módulo: pasa por las mismas reglas que el mensaje.
  it("de la pila, lo que heredó del mensaje pasa por las reglas del mensaje", () => {
    const clean = scrubEvent(
      event({
        exception: {
          values: [
            {
              type: "tel 5512345678",
              stacktrace: {
                frames: [
                  { filename: "5512345678", module: "5512345678", function: "llamar", lineno: 1 },
                  { filename: "ana@correo.com", module: "ana@correo.com", function: "escribir a ana@correo.com" },
                  { filename: "expediente GODE561231GR8", abs_path: "app:///expediente/5512345678" },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(clean.exception?.values?.[0]).toEqual({
      type: "tel [número]",
      stacktrace: {
        frames: [
          { filename: "[número]", module: "[número]", function: "llamar", lineno: 1 },
          { filename: "[correo]", module: "[correo]", function: "escribir a [correo]" },
          { filename: "expediente [rfc]", abs_path: "app:///expediente/[número]" },
        ],
      },
    });
  });

  // El número solo cuenta en una ruta si va suelto. Pegado a letras es el nombre de un
  // archivo compilado o de una versión: cambiarlo le impediría a Sentry traducir la pila.
  it("el nombre de un archivo compilado y el de una versión no se tocan", () => {
    const frame = {
      filename: "app:///_next/static/chunks/1234-4707191299e8abcd.js",
      abs_path: "http://localhost:3000/_next/static/chunks/node_modules_@sentry+core@11.5.0_a1.js",
      module: "chunks/4707191299e8abcd",
    };
    const original = event({
      release: "4707191299e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3",
      dist: "20261008153000",
      debug_meta: { images: [{ type: "sourcemap", code_file: frame.filename, debug_id: UUID }] },
      exception: { values: [{ stacktrace: { frames: [frame] } }] },
    });

    expect(scrubEvent(original)).toEqual(original);
  });

  it("una ruta que lleva un dato en un tramo pasa por las mismas reglas", () => {
    const clean = scrubEvent(
      event({
        transaction: "GET /alumnos/5512345678/GODE561231GR8",
        request: { url: "https://plataforma.example/u/5512345678/GODE561231GR8?x=1" },
        contexts: { nextjs: { request_path: "/u/ana@correo.com/pagos?p=2" } },
        breadcrumbs: [{ category: "navigation", data: { to: "/u/5512345678" } }],
      }),
    );

    expect(clean.transaction).toBe("GET /alumnos/[número]/[rfc]");
    expect(clean.request).toEqual({ url: "https://plataforma.example/u/[número]/[rfc]" });
    expect(clean.contexts?.nextjs).toEqual({ request_path: "/u/[correo]/pagos" });
    expect(clean.breadcrumbs).toEqual([{ category: "navigation", data: { to: "/u/[número]" } }]);
  });

  it("del rastro, solo por dónde se navegó y qué se pidió, sin parámetros", () => {
    const clean = scrubEvent(
      event({
        breadcrumbs: [
          { category: "navigation", data: { from: "/buscar?q=ansiedad", to: "/restablecer?token=abc#x" } },
          {
            category: "fetch",
            type: "http",
            level: "error",
            timestamp: 5,
            data: { method: "GET", url: "https://api.example/v1/cursos?alumno=42", status_code: 500, body: "x" },
          },
          { category: "console", message: "sesión de ana@correo.com" },
          { category: "ui.click", message: 'a[aria-label="Continuar: Duelo y ansiedad"]' },
          { category: "ui.input", message: "input#correo" },
          { category: "sentry.event", message: "algo" },
        ],
      }),
    );

    expect(clean.breadcrumbs).toEqual([
      { category: "navigation", data: { from: "/buscar", to: "/restablecer" } },
      {
        category: "fetch",
        type: "http",
        level: "error",
        timestamp: 5,
        data: { method: "GET", url: "https://api.example/v1/cursos", status_code: 500 },
      },
    ]);
  });

  it("del entorno, solo lo que el propio SDK anota: qué máquina, qué programa, qué ruta", () => {
    const sdk = {
      runtime: { name: "node", version: "v24.11.0" },
      os: { name: "Linux", kernel_version: "5.10.255-268-309.1092.amzn2.x86_64" },
      browser: { name: "Firefox", version: "140" },
      device: { arch: "x64", processor_count: 2, boot_time: "2026-10-08T19:49:44.271Z" },
      app: { app_start_time: "2026-10-08T14:40:12.350Z", app_memory: 139476992 },
      cloud_resource: { "cloud.provider": "vercel", "cloud.region": "iad1" },
      react: { version: "19.3.0" },
      trace: { trace_id: "bec22f59c14f4bfcbeb7338040b99383", span_id: "9405eecee1b592e7" },
      nextjs: { request_path: "/api/error-drill", route_type: "route", router_kind: "App Router" },
    };

    const clean = scrubEvent(
      event({
        contexts: {
          ...sdk,
          cobro: { plan: "mensual", tarjeta: "4242" },
          culture: { locale: "es-MX", timezone: "America/Mexico_City" },
          response: { headers: { "set-cookie": "sesion=abc" } },
        },
      }),
    );

    expect(clean.contexts).toEqual(sdk);
  });

  it("la ruta que Next anota en cada error del servidor sale sin sus parámetros", () => {
    const clean = scrubEvent(
      event({
        contexts: {
          nextjs: { request_path: "/cuenta/verificar?token_hash=abc123&correo=ana%40correo.com" },
        },
      }),
    );

    expect(clean.contexts?.nextjs).toEqual({ request_path: "/cuenta/verificar" });
  });
});

describe("scrubEvent: lo que no sale, sea lo que sea", () => {
  // Un objeto lanzado o rechazado que no es un Error llega aquí, entero, con todas sus
  // claves. Una lista de claves prohibidas no alcanza: nadie previó `curso` ni
  // `diagnostico`.
  it("los datos adjuntos: un objeto lanzado como error no sale con sus claves", () => {
    const clean = scrubEvent(
      event({
        extra: {
          __serialized__: { first_name: "Juanita", curso: "Sanación del duelo", diagnostico: "ansiedad" },
          intento: 3,
        },
      }),
    );

    expect(clean.extra).toBeUndefined();
    expect(asText(clean)).not.toMatch(/Juanita|duelo|ansiedad/);
  });

  it("las etiquetas que no están en la lista", () => {
    const clean = scrubEvent(
      event({ tags: { turbopack: true, simulacro: "si", correo: "ana@correo.com", curso: "Duelo" } }),
    );

    expect(clean.tags).toEqual({ turbopack: true });
  });

  it("lo que el filtro no conoce: un campo nuevo del SDK no pasa por el solo hecho de existir", () => {
    const clean = scrubEvent(
      event({
        server_name: "SerchMSI",
        modules: { next: "16.3.8" },
        logger: "ana@correo.com",
        threads: { values: [] },
        // Un campo que no existe hoy en el tipo: lo que traería una versión futura.
        ...({ campo_nuevo_del_sdk: { correo: "ana@correo.com" } } as object),
      }),
    );

    expect(Object.keys(clean).sort()).toEqual(["type"]);
  });

  // Conocer la clave no basta: lo que trae también tiene que tener su forma. Si no, la
  // promesa de arriba no vale para lo que venga dentro de una clave conocida.
  it("una clave conocida con algo que no es lo suyo adentro", () => {
    const person = { paciente: "Ana Godinez", nota: { dx: "duelo" } };
    const clean = scrubEvent(
      event({
        event_id: "ana@correo.com",
        timestamp: "ayer" as never,
        level: "ana@correo.com" as never,
        platform: person as never,
        environment: "staging de ana@correo.com",
        release: "release-de-ana@correo.com",
        dist: person as never,
        transaction: person as never,
        sdk: {
          name: "sentry.javascript.nextjs",
          version: person as never,
          integrations: ["Http", person as never],
          packages: [{ name: "npm:@sentry/nextjs", version: "11.5.0", ...person }, person as never],
          settings: { infer_ip: "never", ...person },
          ...person,
        },
        debug_meta: {
          images: [
            { type: "sourcemap", code_file: "https://sitio.example/a.js?token=abc", debug_id: UUID, ...person },
            { type: "sourcemap", code_file: person as never, debug_id: "5512345678" },
            person as never,
          ],
          ...person,
        },
        request: { method: person as never, url: person as never },
        tags: { turbopack: person as never },
        contexts: { runtime: { name: "node", version: person as never } },
        breadcrumbs: [
          {
            category: "fetch",
            type: person as never,
            level: person as never,
            timestamp: person as never,
            data: { method: person, status_code: person, url: person },
          },
        ],
        exception: {
          values: [
            {
              type: person as never,
              value: person as never,
              mechanism: { type: person as never, handled: person as never, exception_id: "0" as never },
              stacktrace: {
                frames: [
                  { filename: "a.js", lineno: person as never, colno: "7" as never, in_app: "si" as never, function: person as never },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(clean).toEqual({
      type: undefined,
      environment: "staging de [correo]",
      release: "[correo]",
      sdk: {
        name: "sentry.javascript.nextjs",
        integrations: ["Http"],
        packages: [{ name: "npm:@sentry/nextjs", version: "11.5.0" }],
        settings: { infer_ip: "never" },
      },
      debug_meta: {
        images: [
          { type: "sourcemap", code_file: "https://sitio.example/a.js", debug_id: UUID },
          { type: "sourcemap" },
        ],
      },
      request: {},
      contexts: { runtime: { name: "node" } },
      breadcrumbs: [{ category: "fetch", data: {} }],
      exception: { values: [{ mechanism: {}, stacktrace: { frames: [{ filename: "a.js" }] } }] },
    });
    expect(asText(clean)).not.toMatch(/Godinez|duelo/);
  });

  // Un valor copiado tal cual puede traer su propia forma de convertirse en texto, y
  // fallar al hacerlo cuando el SDK arma el sobre, ya fuera del filtro.
  it("nada de lo que sale puede fallar al convertirse en texto", () => {
    const bomb = {
      toJSON() {
        throw new Error("no se puede escribir");
      },
    };
    const clean = scrubEvent(
      event({
        release: bomb as never,
        sdk: { name: "x", version: bomb as never },
        debug_meta: { images: [{ type: "sourcemap", code_file: "a.js", debug_id: bomb as never }] },
        exception: { values: [{ stacktrace: { frames: [{ lineno: bomb as never }] } }] },
      }),
    );

    expect(() => JSON.stringify(clean)).not.toThrow();
  });

  it("del mecanismo solo el tipo y si se atrapó: no los datos que el SDK le cuelgue", () => {
    const clean = scrubEvent(
      event({
        exception: {
          values: [
            {
              type: "Error",
              mechanism: { type: "onerror", handled: false, data: { url: "/x?token=abc", nota: "ana" } },
            },
          ],
        },
      }),
    );

    expect(clean.exception?.values?.[0]?.mechanism).toEqual({ type: "onerror", handled: false });
  });

  it("no cambia el evento que recibe", () => {
    const original = event({
      message: "ana@correo.com",
      user: { id: UUID, email: "ana@correo.com" },
      extra: { token: "abc" },
    });
    const copy = structuredClone(original);

    scrubEvent(original);

    expect(original).toEqual(copy);
  });
});

// El único texto libre que sale es el mensaje del error. Ahí el filtro reconoce formas (un
// correo, un RFC, una llave), no significados: un nombre propio pasa. Por eso la regla de
// la guía no cambia: el mensaje de un error no lleva el dato de una persona.
describe("scrubEvent: el texto del mensaje", () => {
  const masked = (text: string) => {
    const clean = scrubEvent(
      event({ message: text, exception: { values: [{ type: "Error", value: text }] } }),
    );
    expect(clean.exception?.values?.[0]?.value).toBe(clean.message);
    return clean.message;
  };

  it.each([
    ["un correo", "aviso a ana.perez+cursos@correo.com.mx", "aviso a [correo]"],
    ["un correo codificado en una dirección", "aviso a ana%40correo.com", "aviso a [correo]"],
    ["un correo con eñe en el dominio", "aviso a ana@niño.mx", "aviso a [correo]"],
    ["un correo con eñe en el nombre", "aviso a peña@correo.com", "aviso a [correo]"],
    ["un correo en mayúsculas", "aviso a ANA.PEREZ@CORREO.COM", "aviso a [correo]"],
    ["un correo entre picos", "de <ana@correo.com>", "de <[correo]>"],
    [
      "un token de sesión",
      "token eyJhbGciOiJFUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhbmEiLCJleHAiOjF9.c2lnbmF0dXJhLWRlLXBydWViYQ rechazado",
      "token [token] rechazado",
    ],
    [
      "un token de sesión sin su firma",
      "token eyJhbGciOiJFUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhbmEiLCJleHAiOjF9 cortado",
      "token [token] cortado",
    ],
    ["un portador opaco", "cabecera Bearer a8f3k2j4h5g6d7s8a9 rechazada", "cabecera Bearer [token] rechazada"],
    ["una llave de Stripe", "llave sk_live_51Hx9aBcDeFgHiJkLmNoP inválida", "llave [llave] inválida"],
    ["el secreto de un aviso de cobro", "firma whsec_a1B2c3D4e5F6g7H8 inválida", "firma [llave] inválida"],
    [
      "el secreto de un intento de pago",
      "pago pi_3Nabc123_secret_x7Y8z9W0v1 vencido",
      "pago [llave] vencido",
    ],
    ["una llave de Supabase", "llave sb_secret_AbCdEfGhIjKlMnOp inválida", "llave [llave] inválida"],
    ["una contraseña en un parámetro", "falló con password=S3creta! y más", "falló con password=[filtrado] y más"],
    [
      "un secreto con apellido",
      "refresh_token=v4x2k7tz5ycr9aa client_secret=Zx81kkLmQp77 access_token=opaco_9f8a7b6c5d",
      "refresh_token=[filtrado] client_secret=[filtrado] access_token=[filtrado]",
    ],
    ["una contraseña entre comillas", "falló con password='S3creta!' y más", "falló con password=[filtrado] y más"],
    ["una contraseña tras dos puntos", "falló con password: S3creta!9 y más", "falló con password=[filtrado] y más"],
    [
      "un secreto dentro de un JSON",
      'cuerpo {"password":"hunter2secreto","token":"abc123def456"} rechazado',
      'cuerpo {"password=[filtrado],"token=[filtrado]} rechazado',
    ],
    ["una cabecera de autorización básica", "cabecera Authorization: Basic YXBwOlMzY3JldGEh rechazada", "cabecera Authorization: Basic [token] rechazada"],
    ["una llave de usuario de Sentry", "llave sntryu_a1b2c3d4e5f6a7b8 inválida", "llave [llave] inválida"],
    ["una llave de usuario de GitHub", "llave ghu_a1B2c3D4e5F6g7H8 inválida", "llave [llave] inválida"],
    [
      "una llave privada",
      "no se pudo leer -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY----- del disco",
      "no se pudo leer [llave]",
    ],
    ["un correo codificado dos veces", "aviso a ana%2540correo.com", "aviso a [correo]"],
    ["un teléfono tras un punto", "llamar al Tel.5512345678 mañana", "llamar al Tel.[número] mañana"],
    ["un teléfono tras un guion", "llamar al cel-5512345678 mañana", "llamar al cel-[número] mañana"],
    ["un teléfono con guiones entre espacios", "llamar al 55 - 1234 - 5678 mañana", "llamar al [número] mañana"],
    ["una dirección IP de las largas", "bloqueada la 2806:10a6:12:4c2b:a1b2:c3d4:e5f6:789a por abuso", "bloqueada la [ip] por abuso"],
    ["una dirección IP de las largas, abreviada", "bloqueada la 2806:10a6::e5f6:789a por abuso", "bloqueada la [ip] por abuso"],
    ["un RFC en minúsculas", "el RFC gode561231gr8 no coincide", "el RFC [rfc] no coincide"],
    ["un RFC con guiones", "el RFC GODE-561231-GR8 no coincide", "el RFC [rfc] no coincide"],
    ["una CURP en minúsculas", "la CURP gode561231hdfrrn04 no coincide", "la CURP [curp] no coincide"],
    [
      "una contraseña con arroba",
      ["no conecta a postgres://app", "p@ssw0rd@db.example:5432/app"].join(":"),
      "no conecta a postgres://[credenciales]@db.example:5432/app",
    ],
    [
      "los parámetros de una dirección con paréntesis",
      "GET https://sitio.example/wiki/X_(Y)?code=9f8a7b6c&nombre=Ana dio 500",
      "GET https://sitio.example/wiki/X_(Y) dio 500",
    ],
    [
      "los parámetros de una ruta entre corchetes",
      "ruta [/cuenta/verificar?token_hash=pkce_9f8a7b6c5d4e3f] no existe",
      "ruta [/cuenta/verificar no existe",
    ],
    [
      "el valor que chocó en un índice sobre una función",
      "duplicate key: Key (lower(nombre))=(ana godinez perez) already exists.",
      "duplicate key: Key (lower(nombre))=([valor])",
    ],
    ["el valor que chocó, dicho en español", "Ya existe la llave (nombre)=(Ana Godinez).", "Ya existe la llave (nombre)=([valor])"],
    ["la fila rechazada, dicha en español", "La fila que falla contiene (7, Ana Pérez, ana).", "La fila que falla contiene ([fila])"],
    ["un teléfono de diez dígitos", "llamar al 5512345678 mañana", "llamar al [número] mañana"],
    ["un teléfono con lada y espacios", "llamar al +52 55 1234 5678 mañana", "llamar al [número] mañana"],
    ["un teléfono con paréntesis y guion", "llamar al (55) 1234-5678 mañana", "llamar al [número] mañana"],
    ["un teléfono pegado a una palabra", "campo tel5512345678 inválido", "campo tel[número] inválido"],
    ["una dirección IP", "bloqueada la 189.203.10.4 por abuso", "bloqueada la [ip] por abuso"],
    ["un RFC de persona", "el RFC GODE561231GR8 no coincide", "el RFC [rfc] no coincide"],
    ["un RFC genérico", "el RFC XAXX010101000 no coincide", "el RFC [rfc] no coincide"],
    ["una CURP", "la CURP GODE561231HDFRRN04 no coincide", "la CURP [curp] no coincide"],
    [
      "una cadena de conexión con contraseña",
      ["no conecta a postgresql://app_service", "S3creta@db.example:5432/postgres"].join(":"),
      "no conecta a postgresql://[credenciales]@db.example:5432/postgres",
    ],
    [
      "una cadena de conexión con solo contraseña",
      ["no conecta a redis://", "S3creta@cache.example:6379"].join(":"),
      "no conecta a redis://[credenciales]@cache.example:6379",
    ],
    ["los parámetros de una dirección", "GET https://api.example/v1/x?correo=ana&p=2 dio 500", "GET https://api.example/v1/x dio 500"],
    ["los parámetros de una dirección de socket", "cerró wss://rt.example/v1?apikey=abc123def456", "cerró wss://rt.example/v1"],
    ["los parámetros de una ruta relativa", "GET /api/pagos?rfc=XAXX010101000 respondió 500", "GET /api/pagos respondió 500"],
    ["los parámetros de una ruta tras dos puntos", "path:/cuenta?token=abc falló", "path:/cuenta falló"],
    ["el valor que chocó en la base", "duplicate key: Key (rfc)=(XAXX010101000) already exists.", "duplicate key: Key (rfc)=([valor])"],
    ["la fila que rechazó la base", "Failing row contains (7, Ana Pérez, ana, 1990-01-01).", "Failing row contains ([fila])"],
    ["una fila rechazada que ocupa varias líneas", "Failing row contains (7, Ana\nPérez, ana).\nfin", "Failing row contains ([fila])"],
  ])("enmascara %s", (_name, text, expected) => {
    expect(masked(text)).toBe(expected);
  });

  it.each([
    "Falló sentry+core@11.5.0 al cargar app@1.0.0 y next@16.3.8_react@19.3.0",
    "sesión cs_test_a1B2c3D4e5F6g7H8 vencida",
    "la traza bec22f59c14f4bfcbeb7338040b99383 y el perfil 5b1f0c1e-0000-4000-8000-000000000001",
    "SQLSTATE 23505 en la línea 42, columna 7, tras 1500 ms",
    "no se pudo leer [data-still] ni HTTP500 con ES256",
    "Cannot read properties of undefined (reading 'id')",
    "tardó 10:15:30 en responder la versión 1.2.3",
    "el pedido 123456 de abc y el código 990132 xyz",
    "no hay token ni password en la petición",
  ])("no toca lo que no es un dato de nadie: %j", (text) => {
    expect(masked(text)).toBe(text);
  });

  // La base repite en su mensaje lo que no pudo leer. Un texto así de largo hacía tardar
  // segundos al filtro, con el servidor detenido mientras tanto.
  it("un texto enorme se recorta, y revisar muchos no detiene al servidor", () => {
    const huge = `invalid input syntax for type uuid: "${"a".repeat(80_000)}"`;
    const started = performance.now();
    const clean = scrubEvent(
      event({
        message: huge,
        exception: { values: Array.from({ length: 30 }, () => ({ type: "Error", value: huge })) },
      }),
    );

    expect(performance.now() - started).toBeLessThan(500);
    expect(clean.message?.length).toBeLessThan(2_100);
    expect(clean.message).toContain("[recortado]");
  });

  // Textos armados para hacer trabajar de más a cada regla: cada uno repite el principio
  // de una forma sin dejarla terminar.
  it.each([
    ["un token", "eyJaaaaaaaa-"],
    ["un correo", "a.a.a.a.a.a.a.a@"],
    ["una cadena de conexión", "x://a:b"],
    ["una dirección", "https://a/b"],
    ["un teléfono", "1 2 3 4 5 6 7 8 "],
    ["una IP larga", "a1:b2:c3:"],
  ])("un texto adverso para la regla de %s no la hace tardar", (_name, piece) => {
    const adverse = piece.repeat(Math.ceil(8_000 / piece.length));
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) masked(adverse);

    expect(performance.now() - started).toBeLessThan(400);
  });

  it.each([
    ["un correo", (cut: number) => `${"x ".repeat(cut / 2 - 10)}juan.perez.lopez@gmail.com y sigue ${"y".repeat(5_000)}`],
    // Por partes: escrita de corrido, el escaneo de secretos la toma por una credencial real.
    ["una contraseña", (cut: number) => `${"x ".repeat(cut / 2 - 12)}${["postgres://postgres", "SuperSecreta123@db.example"].join(":")} y sigue ${"y".repeat(5_000)}`],
  ])("el recorte no parte %s a la mitad dejando un trozo a la vista", (_name, build) => {
    for (const cut of [2_000, 4_000]) {
      const clean = masked(build(cut)) ?? "";
      expect(clean).not.toMatch(/juan\.perez|gmai|SuperSecre/);
    }
  });

  // El texto encoge al enmascararse (aquí, una dirección con parámetros larguísimos), y
  // lo que quedó a medias al final de la ventana se acerca al principio. El margen que
  // se desecha tiene que cubrir el dato más largo que una regla necesita ver entero.
  it("el recorte tampoco deja media contraseña cuando el texto encogió", () => {
    const password = "Zq7".repeat(90);
    const text = `GET https://sitio.example/a?${"q".repeat(3_700)}  ${["postgres://app", password].join(":")}@db/app y sigue ${"z".repeat(4_200)}`;

    expect(masked(text)).not.toContain("Zq7");
  });
});

describe("scrubEvent: cuando el propio filtro falla", () => {
  it("manda el error sin un solo texto libre", () => {
    const trap = {};
    Object.defineProperty(trap, "values", {
      enumerable: true,
      get() {
        throw new Error("no se puede leer");
      },
    });

    const clean = scrubEvent(
      event({
        event_id: EVENT_ID,
        environment: "staging",
        message: "ana@correo.com",
        user: { id: UUID, email: "ana@correo.com" },
        exception: trap as ErrorEvent["exception"],
      }),
    );

    expect(asText(clean)).not.toContain("correo.com");
    expect(clean).toMatchObject({
      event_id: EVENT_ID,
      environment: "staging",
      level: "error",
      tags: { filtro_fallido: "si" },
    });
  });

  // Lo que queda de la pila en ese caso: dónde, y nada más. Ni el nombre de la función,
  // que puede venir del mensaje.
  it("de la pila deja dónde fue, y nada que pueda venir del mensaje", () => {
    const crumb = {};
    Object.defineProperty(crumb, "category", {
      enumerable: true,
      get() {
        throw new Error("no se puede leer");
      },
    });

    const clean = scrubEvent(
      event({
        event_id: EVENT_ID,
        release: "release-de-ana@correo.com",
        breadcrumbs: [crumb],
        exception: {
          values: [
            {
              type: "tel 5512345678",
              value: "ana@correo.com",
              stacktrace: {
                frames: [
                  {
                    filename: "app:///src/services/cursos.ts",
                    function: "Ana Godinez",
                    module: "ana@correo.com",
                    lineno: 42,
                    colno: 7,
                    in_app: true,
                    context_line: "const clave = 'S3creta';",
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(clean).toEqual({
      type: undefined,
      event_id: EVENT_ID,
      release: "[correo]",
      level: "error",
      tags: { filtro_fallido: "si" },
      exception: {
        values: [
          {
            type: "tel [número]",
            stacktrace: {
              frames: [{ filename: "app:///src/services/cursos.ts", lineno: 42, colno: 7, in_app: true }],
            },
          },
        ],
      },
    });
  });

  it("y si ni eso se pudo armar, un aviso que no toma nada del evento", () => {
    const hostile = new Proxy(event({ message: "ana@correo.com" }), {
      get() {
        throw new Error("no se puede leer nada");
      },
    });

    const clean = scrubEvent(hostile);

    expect(asText(clean)).not.toContain("correo.com");
    expect(clean.tags).toEqual({ filtro_fallido: "dos veces" });
    expect(clean.level).toBe("error");
    // Con identificador y hora propios: sin ellos Sentry podría no aceptar el aviso.
    expect(clean.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(clean.timestamp).toBeTypeOf("number");
  });
});
