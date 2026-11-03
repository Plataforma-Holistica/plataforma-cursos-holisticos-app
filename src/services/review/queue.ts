import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { parseReviewNote } from "@/domain/catalog/draft-text";

import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";
import { checkAssets, type VideoProviders } from "@/services/media/video-provider";

// La cola de revisión y aprobar un curso (RF-701; PA-61 y PA-62 mínimas, FL-45; T-108).
// Decisiones de Sergio del 2026-10-14: una sola pantalla; reproducir no pide el código
// reciente, y aprobar sí. Quién puede lo decide la base, con la puerta de Contenido
// (`private.approve_course()`); aquí se decide a quién se le pregunta qué y en qué orden, como
// en el servicio del catálogo:
//
//   · La guarda va primero: `teamStanding`, y solo sigue quien es del equipo con Contenido.
//     Los demás reciben `refused`, sin preguntarle nada más a la base. Si no se supo quién
//     pide, `unavailable`.
//   · Un curso sin forma de identificador no llega a la base (`malformed`).
//   · Nada de lo que llega dice quién actúa: sale de la sesión que pasó la guarda.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra su lista
//     cerrada. Otra cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.
//
// El video de cada lección no sale de aquí: lo firma la función única de medios.
//
// Desde T-405 la cola trae además lo enviado por el editor, por su fotografía (`submission`), y Contenido lo devuelve con motivo y qué corregir (`returnCourse`, RF-607) o lo aprueba
// (`approveSubmission`, cuarta solicitud): lleva el envío que se vio, y antes se le pregunta a Mux por cada video, fuera de la transacción, como al enviar. Si no contesta, no se
// aprueba; lo que diga de los subtítulos viaja a la base, que decide (RF-310).

/** Lo que la pantalla dice del video de una lección (un mapa cerrado de la base). */
export const LESSON_VIDEOS = ["playable", "test", "processing", "errored"] as const;
export type LessonVideo = (typeof LESSON_VIDEOS)[number];

/** Un recurso de lo enviado: sin ruta ni objeto, que no salen de la puerta de medios. */
export interface ReviewResource {
  id: string;
  title: string;
  kind: "pdf" | "doc" | "audio";
  sizeBytes: number;
}
export interface ReviewLesson {
  lessonId: string;
  moduleId: string;
  module: string;
  title: string;
  durationSeconds: number;
  video: LessonVideo;
  /** Solo de lo enviado por el editor. */
  description: string | null;
  resources: ReviewResource[];
}
/** El envío: cuál es, para devolverlo, y lo que se aceptó. Nunca el origen de la aceptación (LF-24). */
export interface ReviewSubmission {
  id: string;
  number: number;
  resources: ReviewResource[];
  annex: { version: number; acceptedAt: string; statement: string; termYears: number };
  /** Las lecciones cuyo video todavía no tiene subtítulos: sin ellos no se publica (RF-310). */
  captionsMissing: string[];
}
export interface ReviewCourse {
  courseId: string;
  title: string;
  /** Solo de lo enviado por el editor. */
  summary: string | null;
  teacherName: string;
  /** La ficha del maestro ya está listada: aprobar no la lista otra vez. */
  teacherListed: boolean;
  practice: string | null;
  level: string | null;
  lessonCount: number;
  totalDurationSeconds: number;
  /** Cuándo se cargó, en ISO. */
  loadedAt: string;
  lessons: ReviewLesson[];
  /** Lo enviado por el editor; nulo en un curso cargado por guion. */
  submission: ReviewSubmission | null;
}
export interface ReviewQueue {
  /** Aprobar pasaría hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  /** Los cursos en revisión, el más antiguo primero. */
  courses: ReviewCourse[];
}

/** Lo que contesta `private.approve_course()`. */
export const APPROVE_ANSWERS = [
  "forbidden",
  "needs_fresh_code",
  "not_found",
  "not_pending",
  "self",
  "incomplete",
  "practice_inactive",
  "level_inactive",
  "videos_not_ready",
  "approved",
] as const;
export type ApproveAnswer = (typeof APPROVE_ANSWERS)[number];

/** Lo que contesta `private.review_approve()`, para lo enviado por el editor. */
export const SUBMISSION_APPROVE_ANSWERS = [
  "forbidden",
  "needs_fresh_code",
  "not_found",
  "not_pending",
  "changed",
  "self",
  "teacher_suspended",
  "unavailable",
  "annex_draft",
  "practice_inactive",
  "level_inactive",
  "files_changed",
  "captions_pending",
  "approved",
] as const;
export type SubmissionApproveAnswer = (typeof SUBMISSION_APPROVE_ANSWERS)[number];

/** Los videos de lo enviado, para preguntarle a su proveedor antes de aprobar (`private.review_approve_assets()`). */
export type ApproveAssets =
  | { kind: "ok"; assets: { video: string; lesson: string; provider: string; asset: string | null; playback: string | null }[] }
  | { kind: "forbidden" | "not_found" | "not_pending" };

/** Lo que contesta `private.review_return()`. */
export const RETURN_ANSWERS = ["forbidden", "needs_fresh_code", "not_found", "not_pending", "changed", "self", "invalid", "returned"] as const;
export type ReturnAnswer = (typeof RETURN_ANSWERS)[number];

/** Lo que se devuelve, ya revisado: en NFC y sin espacios en las puntas. */
export interface CourseReturn {
  course: string;
  submission: string;
  reason: string;
  whatToFix: string;
}

/**
 * Lo que este servicio le pregunta a la base, a nombre de las claims que se le pasan. La cola
 * es nula cuando quien actúa no pasa la puerta del equipo con Contenido. Aprobar lanza si la
 * base no contestó algo de su lista: quien llama lo trata como «no se supo».
 */
export interface ReviewStore {
  queue(claims: VerifiedClaims): Promise<ReviewQueue | null>;
  approve(claims: VerifiedClaims, courseId: string): Promise<ApproveAnswer>;
  returnCourse(claims: VerifiedClaims, input: CourseReturn): Promise<ReturnAnswer>;
  approveAssets(claims: VerifiedClaims, courseId: string): Promise<ApproveAssets>;
  /** `captions`: los videos que su proveedor dijo que ya tienen subtítulos. */
  approveSubmission(claims: VerifiedClaims, input: { course: string; submission: string; captions: string[] }): Promise<SubmissionApproveAnswer>;
}

export type QueueRead = { kind: "queue"; queue: ReviewQueue } | { kind: "unavailable" };
export type CourseReturned =
  | { kind: "refused" }
  | { kind: "unavailable" }
  | { kind: "unknown" }
  | { kind: "malformed" }
  | { kind: "answered"; answer: ReturnAnswer };
export type CourseApproved =
  | { kind: "refused" }
  | { kind: "unavailable" }
  | { kind: "unknown" }
  | { kind: "malformed" }
  | { kind: "answered"; answer: ApproveAnswer };
export type SubmissionApproved =
  | { kind: "refused" }
  | { kind: "unavailable" }
  | { kind: "unknown" }
  | { kind: "malformed" }
  /** Videos que su proveedor ya no tiene listos con la reproducción que se publica: sus lecciones. */
  | { kind: "video_not_ready"; lessons: string[] }
  | { kind: "answered"; answer: SubmissionApproveAnswer };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReviewCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  store: ReviewStore;
  providers: VideoProviders;
}

export function createReviewQueue(deps: { report: (code: FailureCode) => Promise<void> }, core: ReviewCore) {
  /**
   * La cola, para la sección que ya pasó su guarda, con las claims que esa guarda dio. Leer no
   * pide el código reciente. Una lectura nula no vale: puede ser que la sesión dejó de pasar
   * entre la guarda y esta lectura, o que la base y la guarda no coinciden. Se le vuelve a
   * preguntar a la guarda, y solo si insiste en que pasa se reporta. Las dos son «no se supo»:
   * «Reintentar» vuelve a correr la guarda, que decide.
   */
  async function reviewQueue(reader: CookieReader, claims: VerifiedClaims): Promise<QueueRead> {
    let queue: ReviewQueue | null;
    try {
      queue = await core.store.queue(claims);
    } catch {
      await deps.report("review_queue_unavailable");
      return { kind: "unavailable" };
    }
    if (queue !== null) return { kind: "queue", queue };
    const team = await core.teamStanding(reader);
    if (team.kind === "team" && holds(team.standing, "content")) await deps.report("review_queue_unavailable");
    return { kind: "unavailable" };
  }

  async function approveCourse(reader: CookieReader, input: { course: unknown }): Promise<CourseApproved> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { kind: "unavailable" };
    if (team.kind !== "team" || !holds(team.standing, "content")) return { kind: "refused" };
    if (typeof input.course !== "string" || !ID.test(input.course)) return { kind: "malformed" };
    try {
      return { kind: "answered", answer: await core.store.approve(team.claims, input.course) };
    } catch {
      await deps.report("course_approval_unavailable");
      return { kind: "unknown" };
    }
  }

  /** Devolver lo enviado (FL-45, paso 7). Lleva el envío que se vio. Un texto que no pasa no llega a la base. */
  async function returnCourse(reader: CookieReader, input: { course: unknown; submission: unknown; reason: unknown; whatToFix: unknown }): Promise<CourseReturned> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { kind: "unavailable" };
    if (team.kind !== "team" || !holds(team.standing, "content")) return { kind: "refused" };
    if (typeof input.course !== "string" || !ID.test(input.course) || typeof input.submission !== "string" || !ID.test(input.submission)) return { kind: "malformed" };
    const reason = typeof input.reason === "string" ? parseReviewNote(input.reason) : null;
    const whatToFix = typeof input.whatToFix === "string" ? parseReviewNote(input.whatToFix) : null;
    if (!reason?.ok || reason.text === null || !whatToFix?.ok || whatToFix.text === null) return { kind: "answered", answer: "invalid" };
    try {
      return { kind: "answered", answer: await core.store.returnCourse(team.claims, { course: input.course, submission: input.submission, reason: reason.text, whatToFix: whatToFix.text }) };
    } catch {
      await deps.report("course_return_unavailable");
      return { kind: "unknown" };
    }
  }

  /**
   * Aprobar lo enviado por el editor (FL-45, paso 8). Lleva el envío que se vio. Hasta preguntarle a la base no se escribió nada: lo que falle antes es «no se pudo», no «no se supo».
   */
  async function approveSubmission(reader: CookieReader, input: { course: unknown; submission: unknown }): Promise<SubmissionApproved> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { kind: "unavailable" };
    if (team.kind !== "team" || !holds(team.standing, "content")) return { kind: "refused" };
    const { course, submission } = input;
    if (typeof course !== "string" || !ID.test(course) || typeof submission !== "string" || !ID.test(submission)) return { kind: "malformed" };
    let assets: ApproveAssets;
    try {
      assets = await core.store.approveAssets(team.claims, course);
    } catch {
      await deps.report("course_approval_unavailable");
      return { kind: "unavailable" };
    }
    if (assets.kind !== "ok") return { kind: "answered", answer: assets.kind };
    const checked = await checkAssets(
      core.providers,
      assets.assets.map((each) => ({ key: each.video, provider: each.provider, asset: each.asset, playback: each.playback })),
    );
    if (checked === null) {
      await deps.report("approve_provider_unavailable");
      return { kind: "unavailable" };
    }
    // La base los da por listos y su proveedor no: alguien tiene que mirar la fila (OP-21).
    if (checked.notReady.length > 0) {
      await deps.report("approve_video_gone");
      return { kind: "video_not_ready", lessons: assets.assets.filter((each) => checked.notReady.includes(each.video)).map((each) => each.lesson) };
    }
    try {
      return { kind: "answered", answer: await core.store.approveSubmission(team.claims, { course, submission, captions: checked.captioned }) };
    } catch {
      await deps.report("course_approval_unavailable");
      return { kind: "unknown" };
    }
  }

  return { reviewQueue, approveCourse, returnCourse, approveSubmission };
}
