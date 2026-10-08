import { existsSync } from "node:fs";

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
}
