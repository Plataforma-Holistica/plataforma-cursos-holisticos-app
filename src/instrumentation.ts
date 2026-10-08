import { EnvError, getEnv } from "@/config/env";
import { reportRequestError } from "@/services/error-reporting/request-error";

// Next llama a `register` una vez, antes de atender la primera petición. Si falta una
// variable de entorno o tiene mala forma, la aplicación no inicia (TRD §11.4).
//
// Lanzar el error no basta: `next start` lo registra y sigue escuchando, respondiendo con
// error a cada petición. Por eso el proceso se termina aquí.
export async function register() {
  // Next compila este archivo también para el entorno Edge, donde `process.exit` no
  // existe. NEXT_RUNTIME no es configuración: Next la sustituye por una constante al
  // compilar, y con eso descarta el bloque en Edge.
  // eslint-disable-next-line no-restricted-properties
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      getEnv();
    } catch (error) {
      if (!(error instanceof EnvError)) throw error;
      console.error(error.message);
      process.exit(1);
    }

    // Después de validar: el registro de errores lee su dirección de esas variables. Se
    // carga aquí adentro, y no arriba, porque es solo de Node: en la compilación para Edge
    // este bloque entero se descarta, y con él la carga.
    const { startErrorReporting } = await import("@/services/error-reporting/server");
    startErrorReporting();
  }
}

// Next llama a esto cada vez que falla una petición en el servidor (RNF-16).
export const onRequestError = reportRequestError;
