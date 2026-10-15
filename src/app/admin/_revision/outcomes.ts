import type { CatalogCode } from "@/services/catalog/catalog";
import { ROUTES } from "@/services/account/navigation";
import type { ReviewGrant } from "@/services/media/media";
import type { CourseApproved } from "@/services/review/review";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace la pantalla de revisión (PA-61 y PA-62 mínimas; FL-45; T-108). Todo
// aquí es puro: los servicios corren la guarda y le preguntan a la base, y esto traduce su
// respuesta a un destino o a lo que se pinta. Cada respuesta tiene su caso: una nueva no
// compila sin el suyo.
//
// Las reglas de las demás secciones valen aquí igual:
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene Contenido
//     (`forbidden`), se le manda a esta misma página, donde decide su guarda.
//   · Lo que llega es qué botón se pulsó. Un envío sin intención, con más de una o con un id
//     sin forma cuenta como vacío. Qué curso, sale del valor del botón.
//   · «No se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor.

export type { CodeState } from "../_lib/fresh-code";

/** A esta misma página: decide su guarda. */
const TO_PAGE: Leave = { kind: "leave", to: ROUTES.review, notice: null };
/**
 * Aprobado: a esta misma página, con el aviso. Una redirección y no volver a pintar: así,
 * sin JavaScript, recargar no reenvía el formulario.
 */
const APPROVED: Leave = { kind: "leave", to: ROUTES.review, notice: "course_approved" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INTENT = 120;

/** Lo que contestó dar el código: la tabla compartida, con esta página. */
export function reviewCodeOutcome(result: CatalogCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.review);
}

// ---------------------------------------------------------------------------------------
// Aprobar: lo que llega.

export type ReviewRequest = { step: "none" } | { step: "cancel" } | { step: "ask"; course: string } | { step: "confirm"; course: string };

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readReviewForm(form: unknown): ReviewRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, course, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (verb === "cancel" && course === undefined) return { step: "cancel" };
  if (course === undefined || !ID.test(course)) return { step: "none" };
  if (verb === "ask") return { step: "ask", course };
  if (verb === "confirm") return { step: "confirm", course };
  return { step: "none" };
}

/** Los valores de los botones. Los arma esta tabla y los lee `readReviewForm`. */
export const reviewButton = {
  ask: (course: string) => `ask:${course}`,
  confirm: (course: string) => `confirm:${course}`,
  cancel: () => "cancel",
} as const;

// ---------------------------------------------------------------------------------------
// Aprobar: lo que se pinta.

export type ReviewFailure =
  | "not_pending"
  | "incomplete"
  | "practice_inactive"
  | "level_inactive"
  | "videos_not_ready"
  | "needs_code"
  | "unavailable"
  | "unknown";

/** Lo que la cola pinta después de un envío. */
export type ReviewState =
  | { kind: "idle" }
  /** El primer paso: se pregunta en el bloque del curso, sin haber llamado a nadie. */
  | { kind: "confirming"; course: string; attempt: number }
  | { kind: "failed"; reason: ReviewFailure; attempt: number };

export type ApproveOutcome = Leave | { kind: "failed"; reason: ReviewFailure };

/** Lo que contestó aprobar. */
export function approveOutcome(result: CourseApproved): ApproveOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "malformed":
      // Solo pasa con un formulario armado a mano: la cola de ahora lo aclara.
      return { kind: "failed", reason: "not_pending" };
    case "answered":
      switch (result.answer) {
        case "approved":
          return APPROVED;
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "not_found":
        case "not_pending":
          return { kind: "failed", reason: "not_pending" };
        case "incomplete":
          return { kind: "failed", reason: "incomplete" };
        case "practice_inactive":
          return { kind: "failed", reason: "practice_inactive" };
        case "level_inactive":
          return { kind: "failed", reason: "level_inactive" };
        case "videos_not_ready":
          return { kind: "failed", reason: "videos_not_ready" };
      }
  }
}

// ---------------------------------------------------------------------------------------
// Reproducir.

/** Lo que el reproductor recibe. Los nombres de los tokens son los de Mux Player. */
export type VideoAnswer =
  | { kind: "granted"; playbackId: string; tokens: { playback: string; thumbnail: string; storyboard: string } }
  | { kind: "no_video" }
  | { kind: "unavailable" };

/**
 * Lo que contestó la función única de medios, para el reproductor. La caducidad no viaja: el
 * reproductor pide otra dirección cuando Mux le dice que la suya caducó.
 */
export function videoAnswerOf(grant: ReviewGrant): Leave | VideoAnswer {
  switch (grant.kind) {
    case "granted":
      // `getMediaGrant` llama `video` al token del video; Mux Player lo llama `playback`.
      return {
        kind: "granted",
        playbackId: grant.playbackId,
        tokens: { playback: grant.tokens.video, thumbnail: grant.tokens.thumbnail, storyboard: grant.tokens.storyboard },
      };
    case "refused":
      return TO_PAGE;
    case "no_video":
      return { kind: "no_video" };
    case "unavailable":
      return { kind: "unavailable" };
  }
}

/** El código con que Mux Player dice que la dirección firmada caducó (`NETWORK_TOKEN_EXPIRED`). */
export const TOKEN_EXPIRED = 2403210;
