import type { StaticImageData } from "next/image";

import faro from "./explorar-faro.jpg";
import estrellas from "./inicio-estrellas.jpg";
import cortina from "./practica-cortina.jpg";
import ventana from "./practica-ventana.jpg";

// Qué foto de ambiente lleva cada lugar (T-614, parte 4; decisiones de Sergio del 2026-11-05). Es puro.
//
// Desde T-616 (solicitud 3), la cabecera del inicio lleva siempre las estrellas, sin alternar con el faro (lo decidió el
// prototipo de la dirección, del carril A), y el faro pasa a la de explorar, del mismo banco (respuesta del carril A del
// 2026-11-12: las fotos de cabecera salen del banco actual, con el criterio del 03 §3.12). Las dos, decisiones sin confirmar.

/**
 * Las fotos de ambiente para el maestro sin retrato (diseño, sección 3.12). Agregar una es sumarla aquí (con su fila en
 * `credits.ts`): los maestros se reparten solos entre todas.
 */
export const PRACTICE_PHOTOS: readonly StaticImageData[] = [ventana, cortina];

/** Un número estable de un texto (FNV-1a de 32 bits): el mismo slug, siempre el mismo. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** De una lista de fotos, la de un maestro por su slug; sin fotos, ninguna. */
export function photoFor<T>(photos: readonly T[], slug: string): T | null {
  if (photos.length === 0) return null;
  return photos[hashOf(slug) % photos.length] ?? null;
}

/**
 * La foto de un maestro sin retrato (T-616, 3b-1; decisión del carril A del 2026-11-12): una por maestro, por su slug, entre
 * las de `PRACTICE_PHOTOS`, la misma en su tarjeta y en su ficha. Antes salía del orden de su primera práctica
 * (`posición % 2`), y los maestros repetían por pares. Quién va sin foto (sin práctica, la inicial) lo decide quien llama.
 */
export function teacherPhoto(slug: string): StaticImageData | null {
  return photoFor(PRACTICE_PHOTOS, slug);
}

/** La de la cabecera del inicio (PA-20). */
export const HOME_HEADER_PHOTO: StaticImageData = estrellas;

/** La de la cabecera de explorar (PA-21). */
export const EXPLORE_HEADER_PHOTO: StaticImageData = faro;
