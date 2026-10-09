import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildOptions } from "./options";
import { serverIntegrations } from "./server";
import { onlyErrors } from "./transport";

// Las demás pruebas de este adaptador simulan el SDK entero: comprueban lo que le
// pedimos, no lo que hace. Esta lo enciende de verdad, con un transporte falso que guarda
// lo que habría salido hacia Sentry, y revisa eso. Es la que se entera si una versión
// nueva del SDK cambia un nombre o empieza a mandar algo más.

type Item = [{ type?: string }, Record<string, unknown>];
const sent: Item[] = [];

// Los datos de prueba viven aquí arriba, lejos de donde se lanza el error. El SDK manda
// las líneas de código que rodean cada punto de la pila (son código nuestro, no datos de
// nadie): escritos junto al error, estos textos saldrían como parte de ese código y la
// prueba no distinguiría eso de una fuga.
const EMAIL = ["ana", "correo.com"].join("@");
const RFC = ["GODE561231", "GR8"].join("");
const IP = [189, 203, 10, 4].join(".");
const PHONE = ["55", "1234", "5678"].join("");
const SURNAME = ["God", "ínez"].join("");
const NOTE = ["due", "lo reciente"].join("");
const THROWN = { paciente: `Ana ${SURNAME}`, nota: { diagnostico: NOTE } };
// Un archivo que existe y cuyo contenido se conoce: el `package.json` de este repositorio.
const PACKAGE_JSON = `${process.cwd().replaceAll("\\", "/")}/package.json`;
const IN_PACKAGE_JSON = ["package", "Manager"].join("");

// Lo único que un evento puede traer en su primer nivel. Si el SDK agrega un campo y el
// filtro lo dejara pasar, esta lista lo delata.
const KNOWN_KEYS = [
  "breadcrumbs",
  "contexts",
  "debug_meta",
  "environment",
  "event_id",
  "exception",
  "level",
  "message",
  "platform",
  "release",
  "request",
  "sdk",
  "tags",
  "timestamp",
  "transaction",
  "type",
  "user",
];

beforeAll(() => {
  Sentry.init({
    ...buildOptions({
      // La clave tiene que ser de letras y números, o el SDK da la dirección por
      // inválida y apaga el transporte sin decir nada.
      dsn: ["https://0123456789abcdef", "o1.ingest.sentry.example/1"].join("@"),
      environment: "staging",
    }),
    integrations: serverIntegrations,
    // Sin esto el SDK registraría OpenTelemetry en el proceso de las pruebas.
    enableOpenTelemetrySetup: false,
    transport: onlyErrors(() => ({
      send: async (envelope: unknown) => {
        sent.push(...(envelope as [unknown, Item[]])[1]);
        return {};
      },
      flush: async () => true,
    })),
  });
});

beforeEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  await Sentry.close(2_000);
});

describe("el SDK de verdad, con lo que sale hacia Sentry a la vista", () => {
  it("queda encendido sin trazas: ni en cero", () => {
    const options = Sentry.getClient()?.getOptions();

    expect(options?.tracesSampleRate).toBeUndefined();
    expect(options?.traceLifecycle).toBe("static");
    expect(options?.sendClientReports).toBe(false);
  });

  // La lista exacta, no «sin estas tres»: es la prueba que falla el día que el SDK trae
  // una integración nueva y alguien la deja pasar, o le cambia el nombre a una conocida.
  it("queda con las integraciones de la lista, y ninguna más", () => {
    const names = Sentry.getClient()?.getOptions().integrations.map(({ name }) => name) ?? [];

    expect([...names].sort()).toEqual([
      "Context",
      "Dedupe",
      "EventFilters",
      "FunctionToString",
      "Http",
      "LinkedErrors",
      "NodeSystemError",
      "OnUncaughtException",
      "OnUnhandledRejection",
      "RequestData",
    ]);
  });

  it("un error con datos de una persona sale como un solo evento, y sin ellos", async () => {
    Sentry.setUser({ id: EMAIL, email: EMAIL, ip_address: IP });
    Sentry.setExtra("telefono", PHONE);
    Sentry.setTag("correo", EMAIL);
    Sentry.setContext("paciente", { correo: EMAIL });
    console.log(`sesión de ${EMAIL}`);
    Sentry.captureException(
      new Error(`duplicate key: Key (rfc)=(${RFC}) already exists for ${EMAIL} al ${PHONE}`),
    );
    await Sentry.flush(2_000);

    expect(sent.map(([header]) => header.type)).toEqual(["event"]);
    const text = JSON.stringify(sent);
    for (const leaked of [EMAIL, "correo.com", RFC, IP, PHONE]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("Key (rfc)=([valor])");
  });

  // `throw { ... }` y `Promise.reject(datos)` existen. El SDK los reporta con el objeto
  // entero, serializado, en `extra`: lo que sea que trajera adentro.
  it("un objeto lanzado como error no sale con lo que traía adentro", async () => {
    Sentry.captureException(THROWN);
    await Sentry.flush(2_000);

    expect(sent.map(([header]) => header.type)).toEqual(["event"]);
    const text = JSON.stringify(sent);
    expect(text).not.toContain(SURNAME);
    expect(text).not.toContain(NOTE);
    expect(sent[0]?.[1]).not.toHaveProperty("extra");
  });

  // El SDK arma la pila leyendo el texto del error. Un mensaje con un salto de línea y
  // algo que parezca un punto de la pila le hacía abrir ese archivo y mandar sus líneas.
  it("un mensaje que nombra un archivo no hace que su contenido salga", async () => {
    const error = new Error("Curso no encontrado");
    error.stack = `Error: Curso no encontrado\n    at leer (${PACKAGE_JSON}:2:1)`;
    Sentry.captureException(error);
    await Sentry.flush(2_000);

    expect(sent).toHaveLength(1);
    const text = JSON.stringify(sent);
    expect(text).not.toContain("context_line");
    expect(text).not.toContain("pre_context");
    expect(text).not.toContain("post_context");
    expect(text).not.toContain(IN_PACKAGE_JSON);
  });

  // Nadie los llama hoy, y el lint impide hacerlo desde fuera del adaptador. Si alguien
  // los llamara, no pasarían por el filtro: se descartan al salir.
  it("lo que no es un error no sale: ni un aviso de trabajo, ni un comentario, ni un adjunto", async () => {
    Sentry.captureCheckIn({ monitorSlug: "cierre-mensual", status: "ok" });
    Sentry.captureFeedback({ message: "no puedo entrar", email: EMAIL, name: SURNAME });
    Sentry.withScope((scope) => {
      scope.addAttachment({ filename: "datos.txt", data: EMAIL });
      Sentry.captureException(new Error("con adjunto"));
    });
    await Sentry.flush(2_000);

    expect(sent.map(([header]) => header.type)).toEqual(["event"]);
    const text = JSON.stringify(sent);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(SURNAME);
  });

  it("ningún evento trae un campo que el filtro no conozca", async () => {
    Sentry.captureException(new Error("uno"));
    Sentry.captureMessage("dos");
    await Sentry.flush(2_000);

    expect(sent).toHaveLength(2);
    for (const [, event] of sent) {
      expect(KNOWN_KEYS).toEqual(expect.arrayContaining(Object.keys(event)));
    }
  });
});
