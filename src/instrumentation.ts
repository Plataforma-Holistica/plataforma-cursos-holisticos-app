import { EnvError, getEnv } from "@/config/env";

// Next llama a `register` una vez, antes de atender la primera petición. Si falta una
// variable de entorno o tiene mala forma, la aplicación no inicia (TRD §11.4).
//
// Lanzar el error no basta: `next start` lo registra y sigue escuchando, respondiendo con
// error a cada petición. Por eso el proceso se termina aquí.
export function register() {
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
  }
}
