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

/** Las fotos por práctica, para el maestro sin retrato (diseño, sección 3.12). */
export const PRACTICE_PHOTOS: readonly [StaticImageData, StaticImageData] = [ventana, cortina];

/** La de una práctica por su orden en el catálogo (PA-67): la misma práctica, siempre la misma. Sin práctica, ninguna. */
export function practicePhoto(position: number | null): StaticImageData | null {
  if (position === null) return null;
  return PRACTICE_PHOTOS[Math.abs(position) % PRACTICE_PHOTOS.length] ?? null;
}

/** La de la cabecera del inicio (PA-20). */
export const HOME_HEADER_PHOTO: StaticImageData = estrellas;

/** La de la cabecera de explorar (PA-21). */
export const EXPLORE_HEADER_PHOTO: StaticImageData = faro;
