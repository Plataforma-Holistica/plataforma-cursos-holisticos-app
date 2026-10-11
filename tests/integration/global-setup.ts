import { existsSync } from "node:fs";

import { assertLocalStack } from "./helpers/local";

// Las pruebas de integración usan las mismas variables que la aplicación. En local salen
// de `.env.local`; en la integración continua ya vienen en el entorno, y lo que ya está
// en el entorno gana sobre el archivo.
export default function setup(): void {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");

  const missing = ["DATABASE_URL", "DATABASE_URL_DIRECT"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Faltan variables para las pruebas de integración: ${missing.join(", ")}. ` +
        "Levanta la base (pnpm db:start), llena .env.local y corre pnpm db:login.",
    );
  }
  // Estas pruebas borran personas y vacían tablas como dueño de la base: antes de la
  // primera, se comprueba que todo lo que van a tocar es la pila local.
  assertLocalStack();
}
