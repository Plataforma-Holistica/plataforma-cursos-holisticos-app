import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { videoMimeOf } from "@/domain/catalog/video-content";

import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";
import { VIDEO_BUCKET, type VideoFiles } from "@/services/media/video-files";
import type { VideoProvider, VideoProviderName, VideoProviders } from "@/services/media/video-provider";

// Los videos del borrador de un curso (RF-604, FL-33; T-403, segunda solicitud). Quién puede lo decide la base; aquí se decide a
// quién se le pregunta qué, y en qué orden.
//
// Subir termina en `uploaded`: `beginVideo` reserva la fila y firma la ruta que la base contestó; el navegador sube por TUS y
// renueva la firma cuando le hace falta (`renewVideoUpload`, que vuelve a preguntar por el maestro y por la fila: la firma dura 2 h
// y una subida de 5 GB puede tardar más); `confirmVideo` lee el archivo y le pregunta a la base, que compara lo que Storage guardó.
//
// Lo que un rechazo o quitar dejan sobrando queda en la papelera de la base, y lo vacía `cleanUp` (T-403, tercera solicitud).
//
// `checkVideos` es la «lectura que repara»: sin webhook (eso es de T-303), el editor pregunta y aquí se le pregunta a la base qué toca
// (`video_due`, que limita por fila) y al proveedor cómo va. Cada video cuesta dinero, y de ahí el orden al crear:
//
//   · Primero se reclama: la base toma la fila y cuenta los topes, una sola vez por video. Dos pestañas no pagan dos veces.
//   · Un reintento busca antes de crear (`retry`), porque un 5xx o un corte no dicen que Mux no lo haya creado. Si la búsqueda no pudo
//     terminar, no se crea: la fila vuelve a `uploaded` y se intenta después. El archivo no se pierde, y solo se pierde tiempo.
//   · Lo que se encontró de más se anota también: la base se queda con uno y manda los otros a la papelera en la misma transacción.
//   · Si el servidor muere entre crear y anotar, el reclamo se vence a los 5 minutos y el reintento lo encuentra.
//
// A Mux se le lee sin tener nada tomado, y solo se escriben estados terminales: una respuesta vieja no pisa. Si no contesta, no se insiste
// en esta pasada: con 10 videos, serían 10 esperas por cada pregunta del editor.

const OPEN = ["not_found", "not_editable", "suspended", "not_teacher"] as const;
export const VIDEO_BEGIN_ANSWERS = ["started", "resumed", "pending", "busy", "closed", "throttled", "too_large", "invalid", "unavailable", ...OPEN] as const;
export const VIDEO_FILE_ANSWERS = ["ok", ...OPEN] as const;
export const VIDEO_CONFIRM_ANSWERS = ["uploaded", "rejected", "expired", "not_uploaded", "unavailable", ...OPEN] as const;
export const VIDEO_REMOVE_ANSWERS = ["deleted", ...OPEN] as const;
export const VIDEO_REJECT_REASONS = ["type", "size", "content", "duration", "too_long"] as const;
export const VIDEO_CLAIM_ANSWERS = ["claimed", "busy", "done", "throttled", "over_minutes", "closed", "invalid", "unavailable", ...OPEN] as const;
export const VIDEO_CREATE_FAILED_ANSWERS = ["uploaded", "stale", "not_found"] as const;
export const VIDEO_CREATED_ANSWERS = ["processing", "gone", "mismatch", "invalid", "not_found"] as const;
export const VIDEO_SETTLE_ANSWERS = ["ready", "errored", "invalid", "unavailable", "not_found"] as const;
export const VIDEO_TRASH_DONE_ANSWERS = ["done", "not_found"] as const;

export type VideoBeginAnswer = (typeof VIDEO_BEGIN_ANSWERS)[number];
export type VideoFileAnswer = (typeof VIDEO_FILE_ANSWERS)[number];
export type VideoConfirmAnswer = (typeof VIDEO_CONFIRM_ANSWERS)[number];
export type VideoRemoveAnswer = (typeof VIDEO_REMOVE_ANSWERS)[number];
export type VideoRejectReason = (typeof VIDEO_REJECT_REASONS)[number];
export type VideoClaimAnswer = (typeof VIDEO_CLAIM_ANSWERS)[number];
export type VideoCreateFailedAnswer = (typeof VIDEO_CREATE_FAILED_ANSWERS)[number];
export type VideoCreatedAnswer = (typeof VIDEO_CREATED_ANSWERS)[number];
export type VideoSettleAnswer = (typeof VIDEO_SETTLE_ANSWERS)[number];
export type VideoTrashDoneAnswer = (typeof VIDEO_TRASH_DONE_ANSWERS)[number];

/** Lo que toca preguntarle al proveedor, reintentar o promover. */
export interface DueVideo {
  video: string;
  state: "uploading" | "uploaded" | "creating" | "processing" | "ready" | "errored";
  provider: string;
  asset: string | null;
  seconds: number | null;
  current: boolean;
}
/** Lo que el servidor debe borrar de Mux y de la cubeta. */
export interface TrashedVideo {
  id: number;
  provider: string | null;
  asset: string | null;
  path: string | null;
}

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
  due: (claims: VerifiedClaims, course: string) => Promise<DueVideo[]>;
  claim: (
    claims: VerifiedClaims,
    input: { course: string; video: string; provider: VideoProviderName },
  ) => Promise<{ answer: VideoClaimAnswer; path: string | null; claim: string | null; retry: boolean; since: number | null }>;
  createFailed: (claims: VerifiedClaims, input: { video: string; claim: string }) => Promise<VideoCreateFailedAnswer>;
  created: (claims: VerifiedClaims, input: { course: string; video: string; provider: VideoProviderName; asset: string }) => Promise<VideoCreatedAnswer>;
  settle: (
    claims: VerifiedClaims,
    input: { video: string; state: "ready" | "errored"; playback: string | null; seconds: number | null; captions: boolean; error: string | null },
  ) => Promise<VideoSettleAnswer>;
  trashDue: (claims: VerifiedClaims, course: string) => Promise<TrashedVideo[]>;
  trashDone: (claims: VerifiedClaims, input: { course: string; id: number }) => Promise<VideoTrashDoneAnswer>;
}

export interface DraftVideosDeps {
  store: VideosStore;
  files: VideoFiles;
  providers: VideoProviders;
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
/** Por qué un video recibido no se está procesando, si quien lo subió puede saberlo. */
export type VideoBlocked = "throttled" | "over_minutes" | "closed";
export type VideoCheckResult = { kind: "checked"; changed: boolean; blocked: Record<string, VideoBlocked> } | Refused;

interface VideoPass {
  changed: boolean;
  blocked: Record<string, VideoBlocked>;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (value: string) => ID.test(value);
const isBlocked = (answer: VideoClaimAnswer): answer is VideoBlocked => answer === "throttled" || answer === "over_minutes" || answer === "closed";

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
      if (confirmed.answer === "rejected" || confirmed.answer === "expired") await cleanUp(claims, input.course);
      return confirmed.answer === "rejected" ? { kind: "rejected", reason: confirmed.reason } : { kind: confirmed.answer };
    });
  }

  function removeVideo(reader: CookieReader, input: { course: string; video: string }) {
    return guarded<{ kind: VideoRemoveAnswer }>(reader, isId(input.course) && isId(input.video), async (claims) => {
      const kind = await deps.store.remove(claims, input);
      if (kind === "deleted") await cleanUp(claims, input.course);
      return { kind };
    });
  }

  /** Vacía la papelera de ese curso. Una falla no tumba lo que ya se hizo: lo que no salió se queda en ella, y se reintenta. */
  async function cleanUp(claims: VerifiedClaims, course: string): Promise<void> {
    let failed = false;
    try {
      for (const item of await deps.store.trashDue(claims, course)) {
        const provider = deps.providers.of(item.provider);
        // Sin llaves no se puede borrar el asset: el archivo se queda con él, para no perder el rastro de lo que se paga.
        if (item.asset !== null && provider === null) continue;
        if (item.asset !== null && provider !== null && !(await provider.remove(item.asset))) {
          failed = true;
          continue;
        }
        try {
          if (item.path !== null) await deps.files.remove([item.path]);
          await deps.store.trashDone(claims, { course, id: item.id });
        } catch {
          failed = true;
        }
      }
    } catch {
      failed = true;
    }
    if (failed) await deps.report("video_cleanup_failed");
  }

  /** Crea en el proveedor lo reclamado. Falso si no contestó. */
  async function createAsset(claims: VerifiedClaims, course: string, video: string, name: VideoProviderName, provider: VideoProvider, pass: VideoPass): Promise<boolean> {
    const claim = await deps.store.claim(claims, { course, video, provider: name });
    if (isBlocked(claim.answer)) pass.blocked[video] = claim.answer;
    if (claim.answer !== "claimed") return true;
    if (claim.path === null || claim.claim === null || claim.since === null) throw new Error("claimed without its facts");
    pass.changed = true;
    const giveUp = async (code: FailureCode) => {
      if (claim.claim !== null) await deps.store.createFailed(claims, { video, claim: claim.claim });
      await deps.report(code);
      return false;
    };
    let assets: string[] = [];
    if (claim.retry) {
      const found = await provider.findByPassthrough(video, claim.since);
      if (found === null) return giveUp("video_provider_unavailable");
      assets = found;
    }
    if (assets.length === 0) {
      const url = await deps.files.signForProvider(claim.path);
      if (url === null) return giveUp("video_original_unavailable");
      const asset = await provider.create({ url, passthrough: video });
      if (asset === null) return giveUp("video_provider_unavailable");
      assets = [asset];
    }
    for (const asset of assets) await deps.store.created(claims, { course, video, provider: name, asset });
    return true;
  }

  /** Asienta lo que dice el proveedor. Falso si no contestó. */
  async function settleAsset(claims: VerifiedClaims, row: DueVideo, provider: VideoProvider, pass: VideoPass): Promise<boolean> {
    if (row.asset === null) return true;
    const read = await provider.read(row.asset, row.seconds);
    if (read === null) {
      await deps.report("video_provider_unavailable");
      return false;
    }
    const failed = (error: string) => ({ video: row.video, state: "errored" as const, playback: null, seconds: null, captions: false, error });
    const finish = async (input: Parameters<VideosStore["settle"]>[1]) => {
      const answer = await deps.store.settle(claims, input);
      if (answer === "ready" || answer === "errored") pass.changed = true;
    };
    if (read === "gone") {
      if (row.state === "processing") await finish(failed("provider_gone"));
      return true;
    }
    if (read.state === "errored") {
      if (row.state === "processing") await finish(failed(read.error ?? "unknown"));
      return true;
    }
    if (read.state !== "ready") return true;
    if (read.playback === null) {
      if (row.state === "processing") {
        await deps.report("video_provider_unavailable");
        await finish(failed("not_signed"));
      }
      return true;
    }
    if (read.seconds === null) {
      if (row.state === "processing") await deps.report("video_provider_unavailable");
      return true;
    }
    // Una vigente sin subtítulos todavía no tiene nada nuevo que anotar.
    if (row.state === "ready" && row.current && !read.captions) return true;
    await finish({ video: row.video, state: "ready", playback: read.playback, seconds: read.seconds, captions: read.captions, error: null });
    return true;
  }

  /** Lo que el editor pregunta al cargar y mientras haya algo en camino. */
  function checkVideos(reader: CookieReader, input: { course: string }): Promise<VideoCheckResult> {
    return guarded<VideoCheckResult>(reader, isId(input.course), async (claims) => {
      const pass: VideoPass = { changed: false, blocked: {} };
      const active = deps.providers.active();
      for (const row of await deps.store.due(claims, input.course)) {
        const creates = row.state === "uploaded" || row.state === "creating";
        const provider = deps.providers.of(creates ? active : row.provider);
        if (provider === null) continue;
        const answered = creates && active !== null ? await createAsset(claims, input.course, row.video, active, provider, pass) : await settleAsset(claims, row, provider, pass);
        if (!answered) break;
      }
      await cleanUp(claims, input.course);
      return { kind: "checked", changed: pass.changed, blocked: pass.blocked };
    });
  }

  return { beginVideo, renewVideoUpload, confirmVideo, removeVideo, checkVideos, cleanUp };
}
