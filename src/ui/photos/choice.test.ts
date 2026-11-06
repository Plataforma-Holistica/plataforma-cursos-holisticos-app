import { describe, expect, it } from "vitest";

import { HOME_HEADER_PHOTOS, homeHeaderPhoto, PRACTICE_PHOTOS, practicePhoto } from "./choice";

// Qué foto de ambiente lleva cada lugar (T-614, parte 4; decisiones de Sergio del 2026-11-05): el maestro sin
// retrato, la de su primera práctica, siempre la misma por práctica; la cabecera del inicio, una por día,
// alternadas e iguales para todos ese día.

describe("practicePhoto", () => {
  it("alterna las dos por el orden de la práctica en el catálogo", () => {
    expect(PRACTICE_PHOTOS).toHaveLength(2);
    expect(practicePhoto(1)).toBe(PRACTICE_PHOTOS[1]);
    expect(practicePhoto(2)).toBe(PRACTICE_PHOTOS[0]);
    expect(practicePhoto(3)).toBe(PRACTICE_PHOTOS[1]);
  });

  it("la misma práctica, siempre la misma foto", () => {
    expect(practicePhoto(7)).toBe(practicePhoto(7));
  });

  it("sin práctica, ninguna: la tarjeta sigue con la inicial", () => {
    expect(practicePhoto(null)).toBeNull();
  });
});

describe("homeHeaderPhoto", () => {
  // La Ciudad de México va seis horas detrás de UTC (sin horario de verano desde 2022).
  const at = (iso: string) => new Date(iso);

  it("alterna entre un día y el siguiente", () => {
    expect(HOME_HEADER_PHOTOS).toHaveLength(2);
    expect(homeHeaderPhoto(at("2026-11-05T18:00:00Z"))).not.toBe(homeHeaderPhoto(at("2026-11-06T18:00:00Z")));
    expect(homeHeaderPhoto(at("2026-11-05T18:00:00Z"))).toBe(homeHeaderPhoto(at("2026-11-07T18:00:00Z")));
  });

  it("es la misma todo el día en la Ciudad de México, también después de las seis de la tarde", () => {
    // 2026-11-05 a las 00:30 y a las 23:30 de la Ciudad de México: el segundo ya es 2026-11-06 en UTC.
    expect(homeHeaderPhoto(at("2026-11-05T06:30:00Z"))).toBe(homeHeaderPhoto(at("2026-11-06T05:30:00Z")));
  });
});
