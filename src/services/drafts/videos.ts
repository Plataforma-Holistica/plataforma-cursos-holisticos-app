import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { videoMimeOf } from "@/domain/catalog/video-content";

import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";
import { VIDEO_BUCKET, type VideoFiles } from "@/services/media/video-files";

// Los videos del borrador de un curso (RF-604, FL-33; T-403, segunda solicitud). Quién puede lo decide la base; aquí se decide a
// quién se le pregunta qué, y en qué orden.
//
// Subir termina en `uploaded`: `beginVideo` reserva la fila y firma la ruta que la base contestó; el navegador sube por TUS y
// renueva la firma cuando le hace falta (`renewVideoUpload`, que vuelve a preguntar por el maestro y por la fila: la firma dura 2 h
// y una subida de 5 GB puede tardar más); `confirmVideo` lee el archivo y le pregunta a la base, que compara lo que Storage guardó.
//
// Lo que un rechazo o quitar dejan sobrando queda en la papelera de la base, y lo vacía la solicitud de Mux.

const OPEN = ["not_found", "not_editable", "suspended", "not_teacher"] as const;
export const VIDEO_BEGIN_ANSWERS = ["started", "resumed", "pending", "busy", "closed", "throttled", "too_large", "invalid", "unavailable", ...OPEN] as const;
export const VIDEO_FILE_ANSWERS = ["ok", ...OPEN] as const;
export const VIDEO_CONFIRM_ANSWERS = ["uploaded", "rejected", "expired", "not_uploaded", "unavailable", ...OPEN] as const;
export const VIDEO_REMOVE_ANSWERS = ["deleted", ...OPEN] as const;
export const VIDEO_REJECT_REASONS = ["type", "size", "content", "duration", "too_long"] as const;

export type VideoBeginAnswer = (typeof VIDEO_BEGIN_ANSWERS)[number];
export type VideoFileAnswer = (typeof VIDEO_FILE_ANSWERS)[number];
export type VideoConfirmAnswer = (typeof VIDEO_CONFIRM_ANSWERS)[number];
export type VideoRemoveAnswer = (typeof VIDEO_REMOVE_ANSWERS)[number];
export type VideoRejectReason = (typeof VIDEO_REJECT_REASONS)[number];

export interface VideosStore {
  begin: (
    claims: VerifiedClaims,
    input: { course: string; lesson: string; fileName: string; mime: string; size: number },
  ) => Promise<{ answer: VideoBeginAnswer; video: string | null; path: string | null; fileName: string | null }>;
  file: (claims: VerifiedClaims, input: { course: string; video: string }) => Promise<{ answer: VideoFileAnswer; path: string | null; mime: string | null }>;
  confirm: (
    claims: VerifiedClaims,
    input: { course: string; video: string; contentOk: boolean | null; seconds: number | null },
  ) => Promise<{ answer: VideoConfirmAnswer; reason: VideoRejectReason | null }>;
  remove: (claims: VerifiedClaims, input: { course: string; video: string }) => Promise<VideoRemoveAnswer>;
}

export interface DraftVideosDeps {
  store: VideosStore;
  files: VideoFiles;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
}

type Refused = { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> } | { kind: "unknown" } | { kind: "invalid" };
export type VideoBeginResult =
  | { kind: "go"; video: string; path: string; mime: string; bucket: string; endpoint: string; token: string; resumed: boolean }
  | { kind: "pending"; video: string; fileName: string }
  | { kind: Exclude<VideoBeginAnswer, "started" | "resumed" | "pending"> }
  | Refused;
export type VideoRenewResult = { kind: "renewed"; token: string } | { kind: Exclude<VideoFileAnswer, "ok"> } | Refused;
export type VideoConfirmResult = { kind: "rejected"; reason: VideoRejectReason | null } | { kind: Exclude<VideoConfirmAnswer, "rejected"> } | Refused;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (value: string) => ID.test(value);

export function createDraftVideos(deps: DraftVideosDeps) {
  /** Corre la guarda y escribe a nombre de la sesión que pasó. Lo que no tiene forma no llega a nadie. */
  async function guarded<Result>(reader: CookieReader, wellFormed: boolean, work: (claims: VerifiedClaims) => Promise<Result>): Promise<Result | Refused> {
    if (!wellFormed) return { kind: "invalid" };
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    try {
      return await work(check.claims);
    } catch {
      await deps.report("draft_change_unavailable");
      return { kind: "unknown" };
    }
  }

  function beginVideo(reader: CookieReader, input: { course: string; lesson: string; fileName: string; size: number }): Promise<VideoBeginResult> {
    const mime = videoMimeOf(input.fileName);
    const formed = isId(input.course) && isId(input.lesson) && mime !== null && Number.isSafeInteger(input.size) && input.size >= 1;
    return guarded<VideoBeginResult>(reader, formed, async (claims) => {
      if (mime === null) return { kind: "invalid" };
      const begun = await deps.store.begin(claims, { course: input.course, lesson: input.lesson, fileName: input.fileName, mime, size: input.size });
      if (begun.answer === "pending") {
        if (begun.video === null || begun.fileName === null) throw new Error("pending without a video");
        return { kind: "pending", video: begun.video, fileName: begun.fileName };
      }
      if (begun.answer !== "started" && begun.answer !== "resumed") return { kind: begun.answer };
      if (begun.video === null || begun.path === null) throw new Error("started without a path");
      const signed = await deps.files.signUpload(begun.path);
      if (signed === null) {
        // Lo recién nacido no ocupa el lugar de la lección 48 h. Una a medias lleva horas de trabajo, y su dirección sigue viva.
        if (begun.answer === "started") await deps.store.remove(claims, { course: input.course, video: begun.video });
        await deps.report("video_upload_unavailable");
        return { kind: "unknown" };
      }
      return { kind: "go", video: begun.video, path: begun.path, mime, bucket: VIDEO_BUCKET, endpoint: signed.endpoint, token: signed.token, resumed: begun.answer === "resumed" };
    });
  }

  function renewVideoUpload(reader: CookieReader, input: { course: string; video: string }): Promise<VideoRenewResult> {
    return guarded<VideoRenewResult>(reader, isId(input.course) && isId(input.video), async (claims) => {
      const file = await deps.store.file(claims, input);
      if (file.answer !== "ok") return { kind: file.answer };
      if (file.path === null) throw new Error("ok without a path");
      const signed = await deps.files.signUpload(file.path);
      if (signed === null) {
        await deps.report("video_upload_unavailable");
        return { kind: "unknown" };
      }
      return { kind: "renewed", token: signed.token };
    });
  }

  function confirmVideo(reader: CookieReader, input: { course: string; video: string }): Promise<VideoConfirmResult> {
    return guarded<VideoConfirmResult>(reader, isId(input.course) && isId(input.video), async (claims) => {
      const file = await deps.store.file(claims, input);
      if (file.answer !== "ok" && file.answer !== "not_found") return { kind: file.answer };
      // Sin ruta el video ya no está subiendo, o no existe: nulo no destruye nada, y la base dice cuál de las dos.
      const facts = file.answer === "ok" && file.path !== null && file.mime !== null ? await deps.files.facts(file.path, file.mime) : { contentOk: null, seconds: null };
      const confirmed = await deps.store.confirm(claims, { ...input, contentOk: facts.contentOk, seconds: facts.seconds });
      return confirmed.answer === "rejected" ? { kind: "rejected", reason: confirmed.reason } : { kind: confirmed.answer };
    });
  }

  function removeVideo(reader: CookieReader, input: { course: string; video: string }) {
    return guarded<{ kind: VideoRemoveAnswer }>(reader, isId(input.course) && isId(input.video), async (claims) => ({ kind: await deps.store.remove(claims, input) }));
  }

  return { beginVideo, renewVideoUpload, confirmVideo, removeVideo };
}
