import type { VideoTarget } from "./tus-upload";

// El video de una lección en el editor (PA-43; T-403): lo que le toca a la persona según lo que contestó el servicio. Es puro, y viaja
// al navegador.

export type VideoProblem =
  | "fileType"
  | "fileSize"
  | "closed"
  | "busy"
  | "throttled"
  | "otherTab"
  | "rejectedType"
  | "rejectedSize"
  | "rejectedContent"
  | "rejectedDuration"
  | "rejectedTooLong"
  | "expired"
  | "notUploaded"
  | "gone"
  | "unavailable";

export type VideoBeginStep =
  | { kind: "go"; target: VideoTarget; token: string; resumed: boolean }
  | { kind: "pending"; fileName: string }
  | { kind: "problem"; problem: VideoProblem };
export type VideoRenewStep = { kind: "renewed"; token: string } | { kind: "problem"; problem: VideoProblem };
export type VideoConfirmStep = { kind: "uploaded" } | { kind: "problem"; problem: VideoProblem };
export type VideoRemoveStep = { kind: "removed" } | { kind: "problem"; problem: VideoProblem };
/** Por qué un video recibido no se está procesando. */
export type VideoBlockedKind = "throttled" | "over_minutes" | "closed" | "failing";
export type VideoCheckStep = { blocked: Record<string, VideoBlockedKind> };

export const VIDEO_BEGIN_PROBLEMS: Readonly<Record<string, VideoProblem>> = {
  busy: "busy",
  closed: "closed",
  throttled: "throttled",
  too_large: "fileSize",
  invalid: "fileType",
  unavailable: "unavailable",
  unknown: "unavailable",
  not_found: "gone",
};

export const VIDEO_CONFIRM_PROBLEMS: Readonly<Record<string, VideoProblem>> = {
  invalid: "unavailable",
  expired: "expired",
  not_uploaded: "notUploaded",
  unavailable: "unavailable",
  unknown: "unavailable",
  not_found: "gone",
};

export const VIDEO_REJECTED: Readonly<Record<string, VideoProblem>> = {
  type: "rejectedType",
  size: "rejectedSize",
  content: "rejectedContent",
  duration: "rejectedDuration",
  too_long: "rejectedTooLong",
};

/** Lo que no se supo o todavía no aparece se puede intentar otra vez sin subir de nuevo. Lo demás ya no tiene fila. */
export const canRetryConfirm = (problem: VideoProblem): boolean => problem === "unavailable" || problem === "notUploaded";

/** Lo que se revisa antes de subir es comodidad: manda la base. `allowed` es si el nombre es de un tipo que se admite. */
export function checkVideoFile(file: { size: number }, allowed: boolean, maxBytes: number | null): VideoProblem | null {
  if (!allowed) return "fileType";
  if (file.size < 1 || (maxBytes !== null && file.size > maxBytes)) return "fileSize";
  return null;
}
