import * as Sentry from "@sentry/nextjs";

import { getEnv } from "@/config/env";

import { buildOptions } from "./options";
import { onlyErrors } from "./transport";

// Sentry en el servidor (RNF-16). Lo enciende el archivo de arranque, una vez, después de
// validar las variables de entorno.
//
// Solo para Node: usa la integración de `http`, que el SDK no trae en el entorno Edge.
// Por eso el arranque lo carga con `import()` dentro de su rama de Node, y lo que Next
// llama al fallar una petición vive aparte, en `request-error.ts`.

/** Lo único que aquí importa de una integración del SDK: cómo se llama. */
interface Integration {
  name: string;
}

// Las integraciones que se quedan. Una lista de permitidas y no de prohibidas: el SDK
// trae de fábrica dos docenas y cada versión agrega alguna, que con una lista de
// prohibidas entraría prendida sin que nadie la viera. Las que no están aquí mandan algo
// más que errores (el conteo de sesiones, la consola, los módulos instalados, las
// variables locales de cada función) o parchean lo que no deben (`fetch`, los procesos
// hijos, los marcos web que no usamos).
//
// Tampoco está ContextLines, que abre cada archivo que la pila nombre y manda sus líneas.
// La pila sale del texto del error: un mensaje con un salto de línea y algo que parezca
// un punto de la pila le hacía abrir esa ruta, fuera la que fuera. Sentry muestra el
// código a partir de los mapas que se suben al compilar.
//
// Una integración nueva se agrega aquí después de leer qué recolecta. La prueba con el
// SDK de verdad (`real-sdk.test.ts`) tiene la lista exacta y falla si cambia.
const ALLOWED = new Set([
  // Descarta lo que no vale la pena mandar y evita repetir el mismo error.
  "EventFilters",
  "Dedupe",
  // Arman bien el error: su causa encadenada, el nombre de las funciones y el código de
  // un error del sistema.
  "FunctionToString",
  "LinkedErrors",
  "NodeSystemError",
  // Atrapan lo que nadie atrapó.
  "OnUncaughtException",
  "OnUnhandledRejection",
  // Qué máquina y qué petición. El filtro deja de la petición el método y la dirección.
  "Context",
  "RequestData",
  // De Next: traduce las rutas de la compilación para que la pila se lea.
  "DistDirRewriteFrames",
]);

/**
 * Las integraciones del servidor: de las de fábrica, solo las de la lista. La de `http`
 * se vuelve a poner sin el conteo de sesiones, sin medir las peticiones que entran, sin
 * el rastro de las que salen y sin cabeceras de rastreo hacia terceros. Queda lo que
 * separa el contexto de una petición del de otra.
 */
export function serverIntegrations(defaults: Integration[]): Integration[] {
  return [
    ...defaults.filter(({ name }) => ALLOWED.has(name)),
    Sentry.httpIntegration({
      disableIncomingRequestSpans: true,
      sessions: false,
      tracePropagation: false,
      breadcrumbs: false,
    }),
  ];
}

/** Sin `SENTRY_DSN` no se enciende: así es como se trabaja en local. */
export function startServerErrorReporting(): void {
  const env = getEnv();
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    ...buildOptions({ dsn: env.SENTRY_DSN, environment: env.APP_ENV }),
    integrations: serverIntegrations,
    transport: onlyErrors(Sentry.makeNodeTransport),
    // Con la variable SENTRY_SPOTLIGHT el SDK manda una copia de cada evento a otra
    // dirección, la que diga la variable. Dicho aquí, la variable no cuenta.
    spotlight: false,
  });
}
