import type { StaticImageData } from "next/image";

import estrellas from "./inicio-estrellas.jpg";
import faro from "./inicio-faro.jpg";
import cortina from "./practica-cortina.jpg";
import ventana from "./practica-ventana.jpg";

// Qué foto de ambiente lleva cada lugar que tiene más de una (T-614, parte 4; decisiones de Sergio del
// 2026-11-05). Es puro: la fecha la da quien llama.

/** Las fotos por práctica, para el maestro sin retrato (diseño, sección 3.12). */
export const PRACTICE_PHOTOS: readonly [StaticImageData, StaticImageData] = [ventana, cortina];

/** La de una práctica por su orden en el catálogo (PA-67): la misma práctica, siempre la misma. Sin práctica, ninguna. */
export function practicePhoto(position: number | null): StaticImageData | null {
  if (position === null) return null;
  return PRACTICE_PHOTOS[Math.abs(position) % PRACTICE_PHOTOS.length] ?? null;
}

/** Las de la cabecera del inicio (PA-20). */
export const HOME_HEADER_PHOTOS: readonly [StaticImageData, StaticImageData] = [faro, estrellas];

const MEXICO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" });

/** La del día: alternan una por día, el mismo para todos, contado en la Ciudad de México. */
export function homeHeaderPhoto(now: Date): StaticImageData {
  const day = Math.floor(Date.parse(`${MEXICO_DAY.format(now)}T00:00:00Z`) / 86_400_000);
  return HOME_HEADER_PHOTOS[day % HOME_HEADER_PHOTOS.length] ?? faro;
}
