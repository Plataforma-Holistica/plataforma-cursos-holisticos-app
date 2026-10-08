import * as Sentry from "@sentry/nextjs";

import { publicEnv } from "@/config/public-env";

import { buildOptions } from "./options";

// Sentry en el navegador (RNF-16). Lo enciende `src/instrumentation-client.ts`, antes de
// que la página cobre vida.
//
// Este archivo viaja al navegador: no importa `@/config/env` ni nada del servidor.

/** Sin dirección no se enciende, y el navegador no manda nada. */
export function startBrowserErrorReporting(): void {
  if (!publicEnv.sentryDsn) return;

  Sentry.init({
    ...buildOptions({ dsn: publicEnv.sentryDsn, environment: publicEnv.appEnv ?? "local" }),
    // Por omisión el navegador le avisa a Sentry de cada visita, haya error o no, para
    // calcular qué porcentaje de visitas falla. Aquí solo salen errores.
    integrations: (defaults) => defaults.filter(({ name }) => name !== "BrowserSession"),
  });
}

/** Un error que una pantalla atrapó. Si Sentry no está encendido, no hace nada. */
export function captureBrowserError(error: unknown): void {
  Sentry.captureException(error);
}
