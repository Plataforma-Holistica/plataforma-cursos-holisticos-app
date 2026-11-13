import { describe, expect, it } from "vitest";

import { EXPLORE_HEADER_PHOTO, HOME_HEADER_PHOTO, PRACTICE_PHOTOS, practicePhoto } from "./choice";
import { PHOTO_CREDITS } from "./credits";

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

/** El archivo de una foto importada: en las pruebas, la importación da su dirección; en Next, un objeto con `src`. */
const fileOf = (photo: unknown) => String(typeof photo === "string" ? photo : (photo as { src: string }).src).split("/").pop()?.split("?")[0];

// Revisión del carril A de la 3a: la prueba de antes solo comparaba que fueran distintas. Ahora, cuál es cada una y dónde la
// registra el registro de créditos.
describe("las cabeceras", () => {
  it.each([
    ["el inicio", HOME_HEADER_PHOTO, "inicio-estrellas.jpg", "inicio"],
    ["explorar", EXPLORE_HEADER_PHOTO, "explorar-faro.jpg", "explorar"],
  ] as const)("%s lleva su foto, registrada para su lugar", (_, photo, file, place) => {
    expect(fileOf(photo)).toBe(file);
    expect(PHOTO_CREDITS.find((credit) => credit.file === file)?.place).toBe(place);
  });
});
