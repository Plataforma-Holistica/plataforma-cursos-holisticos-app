import { captureRequestError, startServerErrorReporting } from "@/adapters/sentry/server";
import { getEnv } from "@/config/env";

// El registro de errores visto desde el servidor (RNF-16). El arranque y las rutas piden
// aquí; qué proveedor lo atiende es asunto del adaptador.

export const startErrorReporting = startServerErrorReporting;

export const reportRequestError = captureRequestError;

/**
 * El simulacro: un error a propósito, para comprobar que el registro lo recibe y que la
 * alerta le llega a una persona. Nunca en producción.
 */
export function errorDrillAllowed(): boolean {
  return getEnv().APP_ENV !== "production";
}

export class ErrorDrill extends Error {
  constructor() {
    super("Simulacro del registro de errores: este error se provocó a propósito.");
    this.name = "ErrorDrill";
  }
}
