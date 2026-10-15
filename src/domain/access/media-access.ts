// Quién recibe una dirección firmada de un video, con qué base, si cuenta para el reparto y
// cuánto dura (RF-305, RF-306, RF-309; RN-01, RN-08; TRD §5.1, §6.1 y §9.4; ADR-27). Reglas
// puras: la función única de medios (`getMediaGrant`) las pregunta y obedece; nada más firma.
//
// Las cuatro reglas de RF-306, cada una con su base. Dos caminos, según desde dónde se pide:
//
//   · `review`, la pantalla de revisión: alguien del equipo con Contenido ve cualquier
//     lección lista, de cualquier curso. Nunca cuenta, aunque además pague (decisión de
//     Sergio del 2026-10-15). La cuenta no se mira.
//   · `watch`, el área del alumno (T-203), en este orden:
//       1. una cuenta suspendida no ve nada, con ninguna base (TRD §5.1);
//       2. un curso que no se puede ver contesta lo mismo que una lección que no existe, para
//          no decir si existe. Se puede ver lo propio (el maestro dueño) y lo publicado y
//          listado;
//       3. sin video que firmar (retirada, de prueba, sin terminar): eso, a quien sí puede ver
//          el curso;
//       4. el maestro dueño ve lo suyo en cualquier estado, también retirado y estando él
//          suspendido como maestro (RF-702; decisión de Sergio del 2026-10-15). Nunca cuenta, y
//          no depende de su cuenta;
//       5. si la regla de la cuenta no se supo (`invalid_input`), «no se supo»: PA-18, nunca
//          PA-33. Va antes del curso abierto: abrirle el curso como a quien no paga a alguien
//          que quizá paga le quitaría los puntos a su maestro;
//       6. suscripción o gracia: esa base, y cuenta, también en el curso abierto (RN-08 solo
//          excluye el curso abierto visto sin suscripción). Alguien del equipo que paga cuenta
//          como cualquier alumno (decisión de Sergio del 2026-10-15);
//       7. cortesía: no cuenta;
//       8. el curso abierto, con el correo verificado: no cuenta;
//       9. si no, sin acceso, con el motivo de la cuenta para PA-33.
//
// `until` es el fin de la base de la cuenta. Si termina a media lección, la dirección ya dada
// vive hasta su caducidad, pero desde ahí no cuenta: los latidos (T-205) revisan el acceso
// cada vez (decisión de Sergio del 2026-10-15).

import type { AccessBasis, AccountAccess } from "./account-access";

/** Desde dónde se pide: la pantalla de revisión, o el área del alumno. */
export const MEDIA_PURPOSES = ["review", "watch"] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

/** Los estados de un curso, como los nombra la base (`public.course_state`). */
export const COURSE_STATES = ["draft", "in_review", "published", "changes_pending", "withdrawn"] as const;
export type CourseState = (typeof COURSE_STATES)[number];

/** Quién pide, como lo dijeron la guarda y la base. */
export interface MediaViewer {
  /** Su cuenta no está activa. */
  accountSuspended: boolean;
  /** Es del equipo, con Contenido y la sesión que pasa la puerta. */
  content: boolean;
  /** El maestro que es, activo o suspendido; nulo si no lo es. */
  teacherId: string | null;
  emailVerified: boolean;
}

/** Lo que la base dice de la lección que se pide, o nulo si no existe. */
export interface MediaLesson {
  /** Una lección retirada por una versión nueva ya no se reproduce. */
  isCurrent: boolean;
  /** Solo los videos de Mux se firman: los de prueba (`test`) no tienen dónde verse. */
  provider: string;
  /** El video terminó de procesarse. */
  ready: boolean;
  teacherId: string;
  courseState: CourseState;
  /** El curso está listado en lo publicado. */
  listed: boolean;
  /** Es el curso abierto (RF-309). */
  isOpen: boolean;
}

export type MediaBasis = AccessBasis | "open_course" | "owner_preview" | "review";

/**
 * Sin acceso por la cuenta: lo que PA-33 dice, con su fecha si terminó. Incluye `suspended`
 * por el tipo, pero la regla nunca lo contesta así: la suspensión va antes, como `suspended`.
 */
export type AccountRefusal = Exclude<AccountAccess, { allowed: true } | { reason: "invalid_input" }>;

export type MediaAccess =
  /** `until`: el fin de la base de la cuenta; nulo si no depende de ella o no tiene fin. */
  | { ok: true; basis: MediaBasis; countsForPayout: boolean; until: Date | null }
  /** Revisar sin Contenido. Se contesta antes de leer la lección: no se dice si existe. */
  | { ok: false; reason: "refused" }
  /** No hay video que firmar, o quien pide no puede ver ese curso: las dos se ven igual. */
  | { ok: false; reason: "no_video" }
  /** La cuenta está suspendida (PA-35). */
  | { ok: false; reason: "suspended" }
  /** No se supo si la cuenta tiene acceso (PA-18, con «Reintentar»). */
  | { ok: false; reason: "unknown" }
  /** La cuenta no tiene acceso (PA-33). */
  | { ok: false; reason: "no_access"; account: AccountRefusal };

/**
 * Si quien pide puede revisar. Se pregunta antes de leer la lección: a quien no puede no se
 * le dice si existe.
 */
export function mayReview(viewer: MediaViewer): boolean {
  return viewer.content;
}

function playable(lesson: MediaLesson): boolean {
  return lesson.isCurrent && lesson.provider === "mux" && lesson.ready;
}

const granted = (basis: MediaBasis, until: Date | null): MediaAccess => ({
  ok: true,
  basis,
  countsForPayout: basis === "subscription" || basis === "grace",
  until,
});

export function resolveMediaAccess(
  purpose: MediaPurpose,
  viewer: MediaViewer,
  account: AccountAccess | null,
  lesson: MediaLesson | null,
): MediaAccess {
  if (purpose === "review") {
    if (!mayReview(viewer)) return { ok: false, reason: "refused" };
    if (lesson === null || !playable(lesson)) return { ok: false, reason: "no_video" };
    return granted("review", null);
  }

  if (viewer.accountSuspended || (account !== null && !account.allowed && account.reason === "suspended")) {
    return { ok: false, reason: "suspended" };
  }
  // La lección siempre tiene maestro: quien no lo es (nulo) nunca es su dueño.
  const owner = lesson !== null && lesson.teacherId === viewer.teacherId;
  const visible =
    lesson !== null && (owner || (lesson.listed && (lesson.courseState === "published" || lesson.courseState === "changes_pending")));
  if (!visible || !playable(lesson)) return { ok: false, reason: "no_video" };
  if (owner) return granted("owner_preview", null);

  if (account === null) return { ok: false, reason: "unknown" };
  if (account.allowed) return granted(account.basis, account.until);
  if (account.reason === "invalid_input") return { ok: false, reason: "unknown" };
  if (lesson.isOpen && viewer.emailVerified) return granted("open_course", null);
  return { ok: false, reason: "no_access", account };
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

/** El paso del menú de velocidades (03 §5.4). Es del diseño, no del negocio. */
export const PLAYBACK_RATE_STEP = 0.25;
/** Un menú que ya no cabe en la pantalla: los parámetros no tienen sentido. */
export const MAX_PLAYBACK_RATES = 16;

/**
 * El menú de velocidades del reproductor (RF-312): de `VELOCIDAD_MIN` a `VELOCIDAD_MAX`, en
 * pasos de 0.25, empezando en el primer paso que no baja de la mínima. Nulo si los parámetros
 * no tienen sentido o no dejan ni un paso: quien lo pide lo trata como «no se supo».
 */
export function playbackRates(minimum: number, maximum: number): number[] | null {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0) return null;
  // En cuartos enteros. Dividir entre 0.25 es exacto en binario: no hay error que arrastrar.
  const first = Math.ceil(minimum / PLAYBACK_RATE_STEP);
  const last = Math.floor(maximum / PLAYBACK_RATE_STEP);
  const count = last - first + 1;
  if (count < 1 || count > MAX_PLAYBACK_RATES) return null;
  return Array.from({ length: count }, (_, index) => (first + index) * PLAYBACK_RATE_STEP);
}

/** El correo más largo que se pinta. Uno de verdad no pasa de 254. */
const WATERMARK_MAX_LENGTH = 320;
// La marca es una sola línea que se lee tal como es: fuera los caracteres de control (también
// los de C1), los separadores de línea y de párrafo, los de ancho cero y los que invierten o
// aíslan la dirección del texto, que harían que el correo se viera distinto de lo que es.
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/**
 * El texto de la marca de agua: el correo de la cuenta, tal cual (03 §5.4). No se le pide más
 * forma que una arroba: un correo que Auth aceptó no deja sin video a quien pagó. Nulo si no
 * hay qué pintar, y entonces no se da video.
 */
export function watermarkText(email: unknown): string | null {
  // Sin arroba no hay correo: eso deja fuera también el vacío y los puros espacios.
  if (typeof email !== "string" || email.length > WATERMARK_MAX_LENGTH) return null;
  if (UNSEEN.test(email) || !email.includes("@")) return null;
  return email;
}
