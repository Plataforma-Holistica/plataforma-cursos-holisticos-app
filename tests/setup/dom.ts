import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Preparación del proyecto `ui` de Vitest. Las aserciones de DOM (`toBeVisible`,
// `toHaveAccessibleName`...) y la limpieza entre pruebas: sin las variables globales de
// Vitest, Testing Library no la registra sola.
afterEach(() => {
  cleanup();
});
