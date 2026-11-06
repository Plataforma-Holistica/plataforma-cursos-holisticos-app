import "@testing-library/jest-dom/vitest";

import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";

// Preparación del proyecto `ui` de Vitest. Las aserciones de DOM (`toBeVisible`,
// `toHaveAccessibleName`...) y la limpieza entre pruebas: sin las variables globales de
// Vitest, Testing Library no la registra sola.

// Cuánto espera `findBy…` y `waitFor` antes de rendirse. El valor de fábrica es un segundo, y con la
// batería entera corriendo a la vez (los dos carriles, la integración continua) una pantalla que pinta su
// aviso y después le pone el foco puede tardar más: la prueba fallaba sin que nada estuviera roto. Esperar
// más no deja pasar nada que esté mal: lo que nunca llega sigue fallando, solo que a los tres segundos.
configure({ asyncUtilTimeout: 3_000 });

// Y una guarda: ninguna prueba pasa si React avisó de dos hermanos con la misma `key`. Ese
// aviso no es cosmético. Con la misma `key`, React confunde un elemento con otro: un aviso
// de un intento anterior se queda en pantalla y se acumula con el siguiente. Pasó en las
// pantallas de la cuenta, y nadie lo vio porque Vitest calla la consola de las pruebas que
// pasan.
const DUPLICATE_KEY = "Encountered two children with the same key";

let duplicateKeys: string[] = [];

beforeEach(() => {
  duplicateKeys = [];
  const original = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (args.some((arg) => typeof arg === "string" && arg.includes(DUPLICATE_KEY))) {
      duplicateKeys.push(args.filter((arg) => typeof arg === "string").join(" "));
    }
    original(...args);
  });
});

afterEach(() => {
  cleanup();
  const found = duplicateKeys;
  duplicateKeys = [];
  vi.mocked(console.error).mockRestore();
  expect(found, "React avisó de hermanos con la misma key").toEqual([]);
});
