import { startServerErrorReporting } from "@/adapters/sentry/server";
import { getEnv } from "@/config/env";

// El registro de errores visto desde el servidor (RNF-16). El arranque y las rutas piden
// aquí; qué proveedor lo atiende es asunto del adaptador.
//
// Solo para Node. Lo que Next llama al fallar una petición está en `request-error.ts`.

export const startErrorReporting = startServerErrorReporting;

/**
 * El simulacro: un error a propósito, para comprobar que el registro lo recibe y que la
 * alerta le llega a una persona. Nunca en producción.
 */
export function errorDrillAllowed(): boolean {
  const env = getEnv();
  // Dos condiciones, de dos fuentes: lo que se escribió en el panel y lo que Vercel dice
  // del despliegue. Un APP_ENV mal puesto no basta para que exista en producción.
  return env.APP_ENV !== "production" && env.VERCEL_ENV !== "production";
}

export class ErrorDrill extends Error {
  constructor() {
    super("Simulacro del registro de errores: este error se provocó a propósito.");
    this.name = "ErrorDrill";
  }
}
