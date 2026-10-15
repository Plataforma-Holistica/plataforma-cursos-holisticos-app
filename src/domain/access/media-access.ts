// Quién recibe una dirección firmada de un video, y cuánto dura (RF-305, RF-306; TRD §6.1 y
// §9.4; ADR-27). Reglas puras: la función única de medios (`getMediaGrant`) las pregunta y
// obedece; nada más firma.
//
// Hoy hay una sola regla, la de revisar: alguien del equipo con Contenido ve cualquier
// lección para revisarla, y eso nunca genera puntos. Las otras tres de RF-306 (suscripción,
// curso abierto y el maestro dueño) llegan con T-202.

/** Quién pide, como lo dijo la guarda del equipo. */
export type MediaViewer = { kind: "team"; content: boolean } | { kind: "other" };

/** Lo que la base dice de la lección que se pide, o nulo si no existe. */
export interface MediaLesson {
  /** Una lección retirada por una versión nueva ya no se reproduce. */
  isCurrent: boolean;
  /** Solo los videos de Mux se firman: los de prueba (`test`) no tienen dónde verse. */
  provider: string;
  /** El video terminó de procesarse. */
  ready: boolean;
}

export type MediaAccess =
  | { ok: true; basis: "review" }
  /** Quien pide no puede ver esa lección. */
  | { ok: false; reason: "no_access" }
  /** No hay video que firmar: no existe, se retiró, es de prueba o no está listo. */
  | { ok: false; reason: "no_video" };

/**
 * Si quien pide puede ver alguna lección. Se pregunta antes de leer la lección: a quien no
 * puede no se le dice si existe.
 */
export function mayRequestMedia(viewer: MediaViewer): boolean {
  return viewer.kind === "team" && viewer.content;
}

export function resolveMediaAccess(viewer: MediaViewer, lesson: MediaLesson | null): MediaAccess {
  if (!mayRequestMedia(viewer)) return { ok: false, reason: "no_access" };
  if (lesson === null || !lesson.isCurrent || lesson.provider !== "mux" || !lesson.ready) {
    return { ok: false, reason: "no_video" };
  }
  return { ok: true, basis: "review" };
}

/** El margen de ADR-27 sobre lo que dura la lección a la velocidad mínima. */
export const GRANT_MARGIN_SECONDS = 10 * 60;
/** El tope de ADR-27: siempre menos de una hora. Más larga, el reproductor pide otra. */
export const GRANT_MAX_SECONDS = 55 * 60;

/**
 * Cuánto dura una dirección firmada: la lección entera a la velocidad mínima, más el margen,
 * sin pasar del tope. Nulo si los datos no tienen sentido (una duración o una velocidad que no
 * son positivas): quien la pide lo trata como «no se supo».
 */
export function grantLifetimeSeconds(durationSeconds: number, minimumSpeed: number): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (!Number.isFinite(minimumSpeed) || minimumSpeed <= 0) return null;
  return Math.min(Math.ceil(durationSeconds / minimumSpeed) + GRANT_MARGIN_SECONDS, GRANT_MAX_SECONDS);
}
