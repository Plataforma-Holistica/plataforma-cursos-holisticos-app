import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import type { SessionCheck } from "@/services/account/admission";
import type { RequestOrigin } from "@/services/account/origin";
import type { ConsentEvidence } from "@/services/account/records";
import type { FailureCode } from "@/services/error-reporting/server";
import { checkAssets, type VideoProviders } from "@/services/media/video-provider";

// Enviar un curso a revisión desde el portal (RF-606, FL-34; PA-44, T-405). La base decide todo lo que importa (`course_submit`): qué falta, qué anexo vale, que lo que se
// firma sea lo que se vio, y los candados. Aquí se decide a quién se le pregunta qué y en qué orden:
//
//   · La guarda de sesión va primero, y solo sigue quien pasa. El maestro activo lo exige la base.
//   · Sin la casilla no se llega a la base: «Acepto» tiene que ser un acto del maestro, no un campo que falte.
//   · Antes de firmar se le pregunta a Mux por cada video vigente, fuera de la transacción (la base no sabe hablar con Mux, y una transacción abierta mientras se espera a la red
//     detendría al curso). Si no contesta, no se envía: firmar un curso con un video que ya no existe sería licenciar algo que nadie puede ver.
//   · El origen (dirección y navegador) se resuelve como al aceptar la invitación del maestro: solo la cabecera de fiar.
//   · Lo que contesta la base se entiende ya confirmada la transacción. Otra cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.

/** Lo que falta para enviar, una línea por cosa, como lo dice `course_readiness`. */
export const MISSING_KINDS = [
  "summary",
  "practice",
  "level",
  "modules",
  "module_empty",
  "lesson_no_video",
  "video_in_progress",
  "video_errored",
  "resource_pending",
] as const;
export type MissingKind = (typeof MISSING_KINDS)[number];

export interface MissingLine {
  what: MissingKind;
  module: string | null;
  lesson: string | null;
  resource: string | null;
  title: string | null;
  /** La revisión de un recurso pendiente: la pide quitarlo. */
  revision: number | null;
}

export interface AnnexText {
  id: string;
  version: number;
  title: string;
  body: string;
  /** En ISO. */
  effectiveFrom: string;
}

/** Lo que el maestro ve antes de firmar: sin la fotografía, solo su huella, para mandarla de vuelta. */
export type SubmitPreview =
  | { kind: "ready"; annex: AnnexText; termYears: number; statement: string; submissionNo: number; contentSha256: string }
  | { kind: "not_ready"; missing: MissingLine[] }
  | { kind: "annex_missing" | "unavailable" | "not_found" | "not_editable" | "suspended" | "not_teacher" };

/** Lo que contesta `private.course_submit()`. */
export const SUBMIT_ANSWERS = [
  "submitted",
  "changed",
  "not_ready",
  "annex_missing",
  "unavailable",
  "origin_missing",
  "invalid",
  "not_found",
  "not_editable",
  "suspended",
  "not_teacher",
] as const;
export type SubmitAnswer = (typeof SUBMIT_ANSWERS)[number];

/** Lo que contesta `private.course_submit_assets()`. */
export type SubmitAssets =
  | { kind: "ok"; assets: { lesson: string; provider: string; asset: string | null; playback: string | null }[] }
  | { kind: "not_found" | "not_editable" | "suspended" | "not_teacher" };

/** Lo que el maestro aceptó (PA-50), sin el origen. */
export interface AcceptedAnnex {
  courseId: string;
  courseTitle: string;
  submissionNo: number;
  acceptedAt: string;
  statement: string;
  termYears: number;
  annex: { id: string; version: number; title: string; effectiveFrom: string };
}

export interface SubmitInput {
  course: string;
  annex: string;
  seen: string;
  term: number;
  submission: number;
}

export interface SubmitStore {
  preview(claims: VerifiedClaims, course: string): Promise<SubmitPreview>;
  assets(claims: VerifiedClaims, course: string): Promise<SubmitAssets>;
  submit(claims: VerifiedClaims, input: SubmitInput, evidence: ConsentEvidence): Promise<SubmitAnswer>;
  accepted(claims: VerifiedClaims): Promise<AcceptedAnnex[]>;
  annex(claims: VerifiedClaims, document: string): Promise<AnnexText | null>;
}

export interface SubmitDeps {
  store: SubmitStore;
  providers: VideoProviders;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  evidence: (origin: RequestOrigin) => ConsentEvidence;
  report: (code: FailureCode) => Promise<void>;
}

export type SubmitRead<Value> = { kind: "ready"; value: Value } | { kind: "unavailable" };

export type CourseSubmitted =
  | { kind: SubmitAnswer }
  /** Sin la casilla marcada: no se le preguntó a nadie. */
  | { kind: "not_accepted" }
  /** El formulario no tiene forma: no se le preguntó a nadie. */
  | { kind: "malformed" }
  /** Videos vigentes que su proveedor ya no tiene listos, o no tiene: sus lecciones, para decir cuáles. */
  | { kind: "video_not_ready"; lessons: string[] }
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unknown" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

export function createSubmit(deps: SubmitDeps) {
  async function read<Value>(work: () => Promise<Value>): Promise<SubmitRead<Value>> {
    try {
      return { kind: "ready", value: await work() };
    } catch {
      await deps.report("draft_read_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** Lo que PA-44 pinta, con las claims con que la guarda del portal dejó pasar. */
  function submitPreview(claims: VerifiedClaims, course: string): Promise<SubmitRead<SubmitPreview>> {
    if (!ID.test(course)) return Promise.resolve({ kind: "ready", value: { kind: "not_found" } });
    return read(() => deps.store.preview(claims, course));
  }

  /** Lo que el maestro aceptó, para PA-50. */
  function acceptedAnnexes(claims: VerifiedClaims): Promise<SubmitRead<AcceptedAnnex[]>> {
    return read(() => deps.store.accepted(claims));
  }

  /** El texto de una versión del anexo, si es la vigente o una que ese maestro aceptó; nulo si no. */
  function annexText(claims: VerifiedClaims, document: string): Promise<SubmitRead<AnnexText | null>> {
    if (!ID.test(document)) return Promise.resolve({ kind: "ready", value: null });
    return read(() => deps.store.annex(claims, document));
  }

  /** Enviar (FL-34, pasos 4 a 6). Lleva lo que se vio y la casilla; el origen sale de la petición. */
  async function submitCourse(
    reader: CookieReader,
    input: { course: unknown; annex: unknown; seen: unknown; term: unknown; submission: unknown; accepted: unknown },
    origin: RequestOrigin,
  ): Promise<CourseSubmitted> {
    const check = await deps.checkSession(reader);
    // La guarda ya reportó lo suyo.
    if (check.kind !== "pass") return { kind: "session", check };
    const { course, annex, seen, term, submission } = input;
    if (typeof course !== "string" || !ID.test(course) || typeof annex !== "string" || !ID.test(annex) || typeof seen !== "string" || !HASH.test(seen) || !isCount(term) || !isCount(submission)) {
      return { kind: "malformed" };
    }
    if (input.accepted !== true) return { kind: "not_accepted" };

    // Hasta aquí no se firmó nada: lo que falle es «no se pudo», no «no se supo».
    let assets: SubmitAssets;
    try {
      assets = await deps.store.assets(check.claims, course);
    } catch {
      await deps.report("draft_read_unavailable");
      return { kind: "unavailable" };
    }
    if (assets.kind !== "ok") return { kind: assets.kind };
    // Cada video vigente, con la reproducción que se firma. Lo que no se supo no se firma a ciegas: un video que ya no existe se licenciaría sin que nadie lo pueda ver.
    const checked = await checkAssets(
      deps.providers,
      assets.assets.map((each) => ({ key: each.lesson, provider: each.provider, asset: each.asset, playback: each.playback })),
    );
    const notReady = checked?.notReady ?? null;
    if (notReady === null) {
      await deps.report("submit_provider_unavailable");
      return { kind: "unavailable" };
    }
    // La base los da por listos y su proveedor no: alguien tiene que mirar la fila (OP-21).
    if (notReady.length > 0) {
      await deps.report("submit_video_gone");
      return { kind: "video_not_ready", lessons: notReady };
    }
    try {
      return { kind: await deps.store.submit(check.claims, { course, annex, seen, term, submission }, deps.evidence(origin)) };
    } catch {
      await deps.report("course_submit_unavailable");
      return { kind: "unknown" };
    }
  }

  return { submitPreview, acceptedAnnexes, annexText, submitCourse };
}
