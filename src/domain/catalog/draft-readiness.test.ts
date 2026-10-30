import { describe, expect, it } from "vitest";

import { missingItems, type DraftReadiness } from "./draft-readiness";

// Lo que le falta a un borrador para enviarlo a revisión (PA-42; decisión de Sergio del 2026-10-29).

const complete: DraftReadiness = { hasSummary: true, practiceReady: true, levelReady: true, lessons: 0, modulesWithLessons: 1 };

describe("missingItems", () => {
  it.each([
    ["un borrador recién creado: resumen, práctica, nivel y un módulo con una lección", { hasSummary: false, practiceReady: false, levelReady: false, lessons: 0, modulesWithLessons: 0 }, 4],
    ["sin resumen", { ...complete, hasSummary: false }, 1],
    ["sin práctica activa", { ...complete, practiceReady: false }, 1],
    ["sin nivel activo", { ...complete, levelReady: false }, 1],
    ["sin un módulo con lección", { ...complete, modulesWithLessons: 0 }, 1],
    // Hasta T-403 ninguna lección tiene video: cada una cuenta.
    ["cada lección sin video", { ...complete, lessons: 3, modulesWithLessons: 2 }, 3],
    ["todo junto", { hasSummary: false, practiceReady: false, levelReady: true, lessons: 2, modulesWithLessons: 1 }, 4],
    ["nada", complete, 0],
  ] as const)("%s", (_name, readiness, expected) => {
    expect(missingItems(readiness)).toBe(expected);
  });

  it("con lecciones, nunca da cero: sin video no se puede enviar", () => {
    for (let lessons = 1; lessons <= 5; lessons += 1) {
      expect(missingItems({ ...complete, lessons })).toBeGreaterThan(0);
    }
  });
});
