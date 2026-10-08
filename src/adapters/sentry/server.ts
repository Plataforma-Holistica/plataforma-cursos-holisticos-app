import * as Sentry from "@sentry/nextjs";

import { getEnv } from "@/config/env";

import { buildOptions } from "./options";

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

// Lo que el SDK trae prendido y manda algo más que errores:
//   - ProcessSession y Http le avisan a Sentry de cada petición, haya error o no (el
//     conteo de sesiones con que calcula qué porcentaje falla);
//   - Console guarda como contexto de cada error lo que se haya escrito en la consola.
const DROPPED = new Set(["ProcessSession", "Console", "Http"]);

/**
 * Las integraciones del servidor: las de fábrica, menos las de arriba. La de `http` se
 * vuelve a poner sin el conteo de sesiones y sin cabeceras de rastreo hacia terceros.
 * Conserva lo que Next necesita de ella: no mide las peticiones que entran.
 */
export function serverIntegrations(defaults: Integration[]): Integration[] {
  return [
    ...defaults.filter(({ name }) => !DROPPED.has(name)),
    Sentry.httpIntegration({
      disableIncomingRequestSpans: true,
      sessions: false,
      tracePropagation: false,
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
  });
}
