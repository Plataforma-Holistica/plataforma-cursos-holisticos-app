import { defineConfig, devices } from "@playwright/test";

// Las pruebas de extremo a extremo (TRD §11.5 y §12.1): un navegador de verdad contra la
// aplicación compilada, la pila local de Supabase y su buzón. Solo corren en local y en la
// integración continua: la vista previa usa el Supabase remoto, que no tiene buzón que se
// pueda leer.
//
// La dirección es exactamente la de `site_url` en `supabase/config.toml`: a ella apuntan
// los enlaces de los correos que manda el Auth local.
const BASE_URL = "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  // `.spec.ts`, para que Vitest, que recoge los `.test.ts`, no las tome por suyas.
  testMatch: "**/*.spec.ts",
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
  projects: [
    { name: "escritorio", use: { ...devices["Desktop Chrome"] } },
    // En teléfono corren los casos marcados: el camino principal y la accesibilidad.
    { name: "telefono", use: { ...devices["Pixel 7"] }, grep: /@telefono/ },
  ],
  webServer: {
    // La aplicación compilada, no la de desarrollo: se compila antes (`pnpm build`).
    command: "pnpm start",
    url: BASE_URL,
    // Si el puerto ya está ocupado, falla y lo dice: probar contra lo que haya ahí
    // (un `pnpm dev`, una compilación vieja) no prueba nada.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
