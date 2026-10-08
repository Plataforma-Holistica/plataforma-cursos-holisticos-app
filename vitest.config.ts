import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Dos proyectos. `unit` es lo que corre `pnpm test`: dominio, configuración y la prueba de
// capas, sin red ni base. `integration` es `pnpm test:int`: necesita la base local arriba
// y a app_service con entrada (`pnpm db:login`).
export default defineConfig({
  resolve: {
    alias: {
      "@": path("./src"),
      // `server-only` lanza fuera de un servidor de React: aquí se cambia por un módulo vacío.
      "server-only": path("./tests/stubs/server-only.ts"),
    },
  },
  test: {
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
