import * as Sentry from "@sentry/nextjs";

import { getEnv } from "@/config/env";

import { buildOptions } from "./options";

// Sentry en el servidor (RNF-16). Lo enciende el archivo de arranque, una vez, después de
// validar las variables de entorno.

/** Sin `SENTRY_DSN` no se enciende: así es como se trabaja en local. */
export function startServerErrorReporting(): void {
  const env = getEnv();
  if (!env.SENTRY_DSN) return;

  Sentry.init(buildOptions({ dsn: env.SENTRY_DSN, environment: env.APP_ENV }));
}

/**
 * Lo que Next llama cuando falla una petición en el servidor: una página, una ruta, una
 * acción o el `proxy`. Si Sentry no está encendido, no hace nada.
 */
export const captureRequestError = Sentry.captureRequestError;
