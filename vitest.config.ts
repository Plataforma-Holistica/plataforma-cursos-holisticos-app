import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Tres proyectos. `pnpm test` corre `unit` y `ui`, sin red ni base:
//   - `unit`: dominio, configuración, catálogo de textos y la prueba de capas.
//   - `ui`: componentes y pantallas, con un DOM simulado.
// `pnpm test:int` corre `integration`: necesita la base local arriba y a app_service con
// entrada (`pnpm db:login`).
export default defineConfig({
  resolve: {
    alias: {
      "@": path("./src"),
      // `server-only` lanza fuera de un servidor de React: aquí se cambia por un módulo vacío.
      "server-only": path("./tests/stubs/server-only.ts"),
    },
  },
  test: {
    // La cobertura solo se mide con `pnpm test:coverage`, y solo sobre las reglas de acceso
    // (TRD §12.2): ahí el umbral es el 100 %, archivo por archivo, y sin él la integración
    // continua no pasa. Va aparte de `pnpm test` porque con cobertura una corrida parcial
    // fallaría por los archivos que no tocó. El porcentaje no ve lo que decide una expresión
    // regular o una tabla: eso lo cuidan las tablas de casos y las propiedades.
    coverage: {
      provider: "v8",
      include: ["src/domain/access/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text"],
      thresholds: {
        "src/domain/access/**": { 100: true, perFile: true },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: ["node_modules/**", "tests/architecture/fixtures/**", "tests/integration/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          // Las pruebas de componentes y de pantallas son las `.test.tsx`.
          include: ["src/**/*.test.tsx", "tests/**/*.test.tsx"],
          exclude: ["node_modules/**", "tests/architecture/fixtures/**"],
          environment: "jsdom",
          setupFiles: ["./tests/setup/dom.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["./tests/integration/global-setup.ts"],
          // Comparten una base: un archivo a la vez.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
