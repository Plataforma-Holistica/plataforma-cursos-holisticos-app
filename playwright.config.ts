import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

import { assertLocalStack } from "./tests/integration/helpers/local";

// Las pruebas de extremo a extremo (TRD §11.5 y §12.1): un navegador de verdad contra la
// aplicación compilada, la pila local de Supabase y su buzón. Solo corren en local y en la
// integración continua: la vista previa usa el Supabase remoto, que no tiene buzón que se
// pueda leer.
//
// La dirección es exactamente la de `site_url` en `supabase/config.toml`: a ella apuntan
// los enlaces de los correos que manda el Auth local.
const BASE_URL = "http://localhost:3000";

// Antes que nada, y antes de levantar la aplicación: las variables salen de `.env.local`
// (en la integración continua ya vienen en el entorno), y todo lo que van a tocar tiene que
// ser la pila local. La aplicación hereda este entorno, y lo heredado gana sobre cualquier
// otro archivo `.env` que Next encuentre: lo que aquí se comprobó es lo que ella usa.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
assertLocalStack();
if (process.env.NEXT_PUBLIC_SITE_URL !== BASE_URL) {
  throw new Error(`NEXT_PUBLIC_SITE_URL debe ser ${BASE_URL}: es a donde apuntan los enlaces de los correos del Auth local.`);
}

// El camino completo de quien es del equipo (invitar, configurar el segundo factor, entrar a
// administración) deja renglones en la auditoría, que no admite borrado, y las pruebas de
// base cuentan esos renglones. Por eso va en su propio proyecto, que solo corre cuando se
// pide con esta variable: nunca con la corrida normal. Después de él la base se rehace
// (`pnpm test:e2e:equipo` lo encadena; en la integración continua es el último paso).
const TEAM_RUN = process.env.E2E_EQUIPO === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  // `.spec.ts`, para que Vitest, que recoge los `.test.ts`, no las tome por suyas. Las del
  // equipo llevan su propia terminación: así la corrida normal no las encuentra.
  testMatch: TEAM_RUN ? "**/*.equipo.ts" : "**/*.spec.ts",
  globalSetup: "./tests/e2e/support/global-setup.ts",
  // Un caso a la vez: comparten la base y, en local, un solo cubo de dirección
  // desconocida para los topes. Cada caso empieza con los contadores vacíos.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  timeout: 45_000,
  use: {
    baseURL: BASE_URL,
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    trace: "retain-on-failure",
  },
  projects: TEAM_RUN
    ? [{ name: "equipo", use: { ...devices["Desktop Chrome"] } }]
    : [
        { name: "escritorio", use: { ...devices["Desktop Chrome"] } },
        // En teléfono corren los casos marcados: el camino principal y la accesibilidad.
        { name: "telefono", use: { ...devices["Pixel 7"] }, grep: /@telefono/ },
      ],
  webServer: {
    // Se compila aquí mismo y se sirve eso: así nunca se prueba una compilación de antes.
    // Sin pasar por `package.json`: este archivo tiene dueño y aquel no.
    command: "pnpm exec next build && pnpm exec next start",
    url: BASE_URL,
    // Si el puerto ya está ocupado, falla y lo dice: probar contra lo que haya ahí
    // (un `pnpm dev`, otra aplicación) no prueba nada.
    reuseExistingServer: false,
    timeout: 240_000,
    // Estas pruebas provocan errores a propósito: no se le mandan al registro de errores.
    // Vacía cuenta como ausente, al compilar (el navegador) y al servir (el servidor).
    env: { SENTRY_DSN: "" },
  },
});
