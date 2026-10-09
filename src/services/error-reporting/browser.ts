import { captureBrowserError, startBrowserErrorReporting } from "@/adapters/sentry/browser";

// El registro de errores visto desde el navegador (RNF-16). Este archivo viaja al
// navegador: no importa nada del servidor.

export const startErrorReporting = startBrowserErrorReporting;

/**
 * Reporta un error que una pantalla de error atrapó.
 *
 * Un error que nació en el servidor llega al navegador sin mensaje y con un código
 * (`digest`). Ese ya lo reportó el servidor, con su pila completa: aquí no se repite.
 */
export function reportCaughtError(error: Error & { digest?: string }): void {
  if (error.digest) return;
  captureBrowserError(error);
}
