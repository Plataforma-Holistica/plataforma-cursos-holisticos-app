import { describe, expect, it } from "vitest";

import { EXPLORE_HEADER_PHOTO, HOME_HEADER_PHOTO, PRACTICE_PHOTOS, practicePhoto } from "./choice";

// Qué foto de ambiente lleva cada lugar (T-614, parte 4; decisiones de Sergio del 2026-11-05): el maestro sin
// retrato, la de su primera práctica, siempre la misma por práctica. Desde T-616 (solicitud 3, por el prototipo de la
// dirección), la cabecera del inicio lleva siempre las estrellas y el faro va en la de explorar.

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

describe("las cabeceras", () => {
  it("el inicio y explorar llevan cada una la suya, y no la de una práctica", () => {
    expect(HOME_HEADER_PHOTO).not.toBe(EXPLORE_HEADER_PHOTO);
    expect(PRACTICE_PHOTOS).not.toContain(HOME_HEADER_PHOTO);
    expect(PRACTICE_PHOTOS).not.toContain(EXPLORE_HEADER_PHOTO);
  });
});
