import { describe, expect, it } from "vitest";

import { EXPLORE_HEADER_PHOTO, HOME_HEADER_PHOTO, PRACTICE_PHOTOS, photoFor, teacherPhoto } from "./choice";
import { PHOTO_CREDITS } from "./credits";

// Qué foto de ambiente lleva cada lugar (T-614, parte 4; decisiones de Sergio del 2026-11-05). Desde T-616 (solicitud 3,
// por el prototipo de la dirección), la cabecera del inicio lleva siempre las estrellas y el faro va en la de explorar.
//
// Cambió por el requisito (T-616, 3b-1; decisión del carril A del 2026-11-12): el maestro sin retrato ya no lleva la foto
// de su primera práctica por el orden de esta (`posición % 2`, y los maestros repetían por pares), sino una por maestro,
// elegida por su slug entre las que haya: al sumar fotos a la lista se reparten solas.

describe("teacherPhoto", () => {
  const slugs = Array.from({ length: 80 }, (_, index) => `maestro-${index}`);

  it("el mismo maestro, siempre la misma foto, de las de práctica", () => {
    expect(teacherPhoto("ana-robles")).toBe(teacherPhoto("ana-robles"));
    for (const slug of slugs) expect(PRACTICE_PHOTOS).toContain(teacherPhoto(slug));
  });

  it("con las fotos de hoy, entre los maestros las usa todas", () => {
    expect(new Set(slugs.map(teacherPhoto))).toEqual(new Set(PRACTICE_PHOTOS));
  });

  it("con N fotos, las usa todas, y cada maestro sigue con una sola", () => {
    for (const count of [1, 3, 4, 7]) {
      const photos = Array.from({ length: count }, (_, index) => `foto-${index}`);
      expect(new Set(slugs.map((slug) => photoFor(photos, slug))), `${count} fotos`).toEqual(new Set(photos));
      expect(photoFor(photos, "ana-robles")).toBe(photoFor(photos, "ana-robles"));
    }
  });

  it("sin fotos, ninguna", () => {
    expect(photoFor([], "ana-robles")).toBeNull();
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
