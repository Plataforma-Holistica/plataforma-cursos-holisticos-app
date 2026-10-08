import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildOptions } from "./options";
import { serverIntegrations } from "./server";

// Las demás pruebas de este adaptador simulan el SDK entero: comprueban lo que le
// pedimos, no lo que hace. Esta lo enciende de verdad, con un transporte falso que guarda
// lo que habría salido hacia Sentry, y revisa eso. Es la que se entera si una versión
// nueva del SDK cambia un nombre o empieza a mandar algo más.

type Item = [{ type?: string }, unknown];
const sent: Item[] = [];

// Los datos de prueba viven aquí arriba, lejos de donde se lanza el error. El SDK manda
// las líneas de código que rodean cada punto de la pila (son código nuestro, no datos de
// nadie): escritos junto al error, estos textos saldrían como parte de ese código y la
// prueba no distinguiría eso de una fuga.
const EMAIL = ["ana", "correo.com"].join("@");
const RFC = ["GODE561231", "GR8"].join("");
const IP = [189, 203, 10, 4].join(".");
const PHONE = ["55", "1234", "5678"].join("");

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
    transport: () => ({
      send: async (envelope: unknown) => {
        sent.push(...(envelope as [unknown, Item[]])[1]);
        return {};
      },
      flush: async () => true,
    }),
  });
});

afterAll(async () => {
  await Sentry.close(2_000);
});

describe("el SDK de verdad, con lo que sale hacia Sentry a la vista", () => {
  it("queda encendido sin trazas y sin las integraciones que mandan algo más que errores", () => {
    const client = Sentry.getClient();
    expect(client?.getOptions().tracesSampleRate).toBe(0);

    const names = client?.getOptions().integrations.map(({ name }) => name) ?? [];
    expect(names).toContain("Http");
    expect(names).not.toContain("ProcessSession");
    expect(names).not.toContain("Console");
  });

  it("un error con datos de una persona sale como un solo evento, y sin ellos", async () => {
    Sentry.setUser({ id: EMAIL, email: EMAIL, ip_address: IP });
    Sentry.setExtra("telefono", PHONE);
    Sentry.setExtra("nota", `llamar al ${PHONE}`);
    console.log(`sesión de ${EMAIL}`);
    Sentry.captureException(
      new Error(`duplicate key: Key (rfc)=(${RFC}) already exists for ${EMAIL}`),
    );
    await Sentry.flush(2_000);

    expect(sent.map(([header]) => header.type)).toEqual(["event"]);
    const text = JSON.stringify(sent);
    for (const leaked of [EMAIL, "correo.com", RFC, IP, PHONE]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("Key (rfc)=([valor])");
    expect(text).toContain("llamar al [número]");
  });
});
