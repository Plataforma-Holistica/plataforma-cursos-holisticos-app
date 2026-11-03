import type { CatalogCode } from "@/services/catalog/catalog";
import { ROUTES } from "@/services/account/navigation";
import { parseReviewNote, REVIEW_NOTE_MAX } from "@/services/drafts/field-rules";
import type { ReviewGrant, ReviewVideoGrant } from "@/services/media/media";
import type { CourseApproved, CourseReturned, SubmissionApproved } from "@/services/review/review";

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

/** Devuelto: a esta misma página, con el aviso. Por lo mismo que aprobar. */
const RETURNED: Leave = { kind: "leave", to: ROUTES.review, notice: "course_returned" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INTENT = 120;

/** Lo que contestó dar el código: la tabla compartida, con esta página. */
export function reviewCodeOutcome(result: CatalogCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.review);
}

// ---------------------------------------------------------------------------------------
// Aprobar: lo que llega.

/** `submission`: el envío que se vio, en lo enviado por el editor (T-405). Un curso por guion no lo lleva. */
export type ReviewRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "ask"; course: string; submission?: string }
  | { step: "confirm"; course: string; submission?: string };

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readReviewForm(form: unknown): ReviewRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, course, submission, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (verb === "cancel" && course === undefined) return { step: "cancel" };
  if (course === undefined || !ID.test(course)) return { step: "none" };
  if (submission !== undefined && !ID.test(submission)) return { step: "none" };
  const seen = submission === undefined ? {} : { submission };
  if (verb === "ask") return { step: "ask", course, ...seen };
  if (verb === "confirm") return { step: "confirm", course, ...seen };
  return { step: "none" };
}

/** Los valores de los botones. Los arma esta tabla y los lee `readReviewForm`. */
export const reviewButton = {
  ask: (course: string, submission?: string) => (submission === undefined ? `ask:${course}` : `ask:${course}:${submission}`),
  confirm: (course: string, submission?: string) => (submission === undefined ? `confirm:${course}` : `confirm:${course}:${submission}`),
  cancel: () => "cancel",
} as const;

// ---------------------------------------------------------------------------------------
// Aprobar: lo que se pinta.

export type ReviewFailure =
  | "not_pending"
  | "self"
  | "incomplete"
  | "practice_inactive"
  | "level_inactive"
  | "videos_not_ready"
  // Lo enviado por el editor (T-405).
  | "changed"
  | "teacher_suspended"
  | "annex_draft"
  | "files_changed"
  | "captions_pending"
  | "video_gone"
  | "needs_code"
  | "unavailable"
  | "unknown";

/** Lo que la cola pinta después de un envío. */
export type ReviewState =
  | { kind: "idle" }
  /** El primer paso: se pregunta en el bloque del curso, sin haber llamado a nadie. */
  /** `submission`: el envío que se vio al preguntar. Es el que se aprueba: si llegó otro, la base contesta `changed`. */
  | { kind: "confirming"; course: string; submission: string | null; attempt: number }
  /** `lessons`: las de un video que su proveedor ya no tiene listo (`video_gone`). */
  | { kind: "failed"; reason: ReviewFailure; lessons?: string[]; attempt: number };

export type ApproveOutcome = Leave | { kind: "failed"; reason: ReviewFailure; lessons?: string[] };

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
        case "self":
          return { kind: "failed", reason: "self" };
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

/** Lo que contestó aprobar lo enviado por el editor (T-405). */
export function approveSubmissionOutcome(result: SubmissionApproved): ApproveOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "malformed":
      return { kind: "failed", reason: "not_pending" };
    case "video_not_ready":
      return { kind: "failed", reason: "video_gone", lessons: result.lessons };
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
        case "unavailable":
          return { kind: "failed", reason: "unavailable" };
        case "changed":
        case "self":
        case "teacher_suspended":
        case "annex_draft":
        case "practice_inactive":
        case "level_inactive":
        case "files_changed":
        case "captions_pending":
          return { kind: "failed", reason: result.answer };
      }
  }
}

// ---------------------------------------------------------------------------------------
// Devolver (RF-607; FL-45, paso 7). Cada curso lleva su propio formulario y su estado: lo escrito no se mezcla con otro curso.

export const RETURN_REASON_FIELD = "motivo";
export const RETURN_FIX_FIELD = "que_corregir";
/** El tope que pinta cada campo: el navegador no deja pasar de ahí. */
export const RETURN_MAX = REVIEW_NOTE_MAX;

export type ReturnRequest =
  | { step: "none" }
  | { step: "cancel"; course: string }
  | { step: "ask"; course: string; submission: string; reason: string; whatToFix: string }
  | { step: "send"; course: string; submission: string; reason: string; whatToFix: string };

const textField = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. Pasar a otro envío también lleva lo escrito: no se pierde. */
export function readReturnForm(form: unknown): ReturnRequest {
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, course, submission, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (course === undefined || !ID.test(course)) return { step: "none" };
  if (verb === "return_cancel" && submission === undefined) return { step: "cancel", course };
  if (submission === undefined || !ID.test(submission)) return { step: "none" };
  const written = { reason: textField(form, RETURN_REASON_FIELD), whatToFix: textField(form, RETURN_FIX_FIELD) };
  if (verb === "return_ask") return { step: "ask", course, submission, ...written };
  if (verb === "return_send") return { step: "send", course, submission, ...written };
  return { step: "none" };
}

/** Los valores de los botones. Los arma esta tabla y los lee `readReturnForm`. */
export const returnButton = {
  ask: (course: string, submission: string) => `return_ask:${course}:${submission}`,
  send: (course: string, submission: string) => `return_send:${course}:${submission}`,
  cancel: (course: string) => `return_cancel:${course}`,
} as const;

export type ReturnProblem = "empty" | "too_long" | "invalid";
export interface ReturnProblems {
  reason: ReturnProblem | null;
  whatToFix: ReturnProblem | null;
}
export const NO_RETURN_PROBLEMS: ReturnProblems = { reason: null, whatToFix: null };

const problemOf = (text: string): ReturnProblem | null => {
  const parsed = parseReviewNote(text);
  if (!parsed.ok) return parsed.reason;
  return parsed.text === null ? "empty" : null;
};

/** Lo que está mal en lo escrito, con la misma regla de la base: así se dice en su campo y no se pierde. Los dos son obligatorios. */
export function returnProblems(input: { reason: string; whatToFix: string }): ReturnProblems {
  return { reason: problemOf(input.reason), whatToFix: problemOf(input.whatToFix) };
}

export type ReturnFailure = "not_pending" | "changed" | "self" | "invalid" | "needs_code" | "unavailable" | "unknown";

export type ReturnState =
  | { kind: "idle" }
  /** Se cerró: el foco vuelve a ese curso. */
  | { kind: "closed"; course: string }
  /**
   * Se pregunta dentro del curso, con lo escrito: viaja en el estado, porque React devuelve el formulario a sus valores por omisión. `submission` es el envío que se está viendo: es el
   * que se devuelve, y solo cambia cuando quien revisa pide seguir con el de ahora. Así, un envío nuevo nunca recibe un rechazo escrito para otro.
   */
  | { kind: "open"; course: string; submission: string; reason: string; whatToFix: string; problems: ReturnProblems; failure: ReturnFailure | null; attempt: number };

export type ReturnOutcome = Leave | { kind: "failed"; reason: ReturnFailure };

/** Lo que contestó devolver. */
export function returnOutcome(result: CourseReturned): ReturnOutcome {
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
        case "returned":
          return RETURNED;
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "not_found":
        case "not_pending":
          return { kind: "failed", reason: "not_pending" };
        case "changed":
          return { kind: "failed", reason: "changed" };
        case "self":
          return { kind: "failed", reason: "self" };
        case "invalid":
          return { kind: "failed", reason: "invalid" };
      }
  }
}

// ---------------------------------------------------------------------------------------
// Reproducir.

/** Lo que el reproductor recibe. Los nombres de los tokens son los de Mux Player. */
export type VideoAnswer =
  | {
      kind: "granted";
      playbackId: string;
      tokens: { playback: string; thumbnail: string; storyboard: string };
      speeds: number[];
      /** Solo en lo enviado por el editor: el correo de quien revisa, encima del video. */
      watermark?: string;
    }
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
        speeds: grant.speeds,
      };
    case "refused":
      return TO_PAGE;
    case "no_video":
      return { kind: "no_video" };
    case "unavailable":
      return { kind: "unavailable" };
  }
}

/** Lo mismo para lo enviado por el editor (PA-62), que además lleva la marca de agua. */
export function reviewVideoAnswerOf(grant: ReviewVideoGrant): Leave | VideoAnswer {
  switch (grant.kind) {
    case "granted":
      return {
        kind: "granted",
        playbackId: grant.playbackId,
        tokens: { playback: grant.tokens.video, thumbnail: grant.tokens.thumbnail, storyboard: grant.tokens.storyboard },
        speeds: grant.speeds,
        watermark: grant.watermark,
      };
    case "refused":
      return TO_PAGE;
    case "no_video":
      return { kind: "no_video" };
    case "unavailable":
      return { kind: "unavailable" };
  }
}
