import { ROUTES } from "@/services/account/navigation";
import { parseLegalBody, parseLegalDay, parseLegalTitle } from "@/services/legal/field-rules";
import type { LegalBlock } from "@/services/legal/blocks";
import type { LegalCode, LegalDocType, VersionPublished } from "@/services/legal/legal-admin";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace PA-89, los textos legales (T-110; FL-57). Todo aquí es puro: el servicio corre la
// guarda y le pregunta a la base, y esto traduce su respuesta a un destino o a lo que se pinta. Cada
// respuesta de la base tiene su caso: una nueva se agrega aquí, con su prueba.
//
// Publicar va en tres pasos, todos en un mismo bloque con su acción y su estado: «Nueva versión» abre el
// formulario (no llama a nadie), «Ver cómo queda» revisa lo escrito y pinta la vista previa con la
// consecuencia (tampoco llama a nadie), y «Publicar» lleva la versión que se vio y la huella del texto de la
// vista previa. Lo que se publica es lo que se revisó: si el texto que llega ya no es ese, no se publica.
//
// Las reglas de las otras secciones valen aquí igual: a quien la guarda no dejó (`refused`), o a quien la
// base le dijo que no tiene configuración (`forbidden`), se le manda a esta misma página, donde decide su
// guarda; lo que llega es qué botón se pulsó y lo escrito, y lo que no se entiende cuenta como vacío;
// «no se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor.

export type { CodeState } from "../_lib/fresh-code";

/** A esta misma página: decide su guarda. */
const TO_PAGE: Leave = { kind: "leave", to: ROUTES.legalTexts, notice: null };

const TYPES: readonly LegalDocType[] = [
  "terms",
  "student_privacy_notice",
  "teacher_privacy_notice",
  "community_policy",
  "refund_policy",
  "teacher_agreement",
  "license_annex",
  "course_history_consent",
  "recurring_charge_consent",
];
const SEEN = /^(none|0|[1-9][0-9]{0,8})$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_INTENT = 160;
// Lo que se acepta leer de cada campo. Más largo llega cortado, y la regla lo da por largo.
const MAX_TITLE_READ = 2_001;
const MAX_BODY_READ = 800_001;
const MAX_DAY_READ = 20;

/** Lo que contestó dar el código: la tabla compartida, con esta página. */
export function legalCodeOutcome(result: LegalCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.legalTexts);
}

// ---------------------------------------------------------------------------------------
// Lo que llega.

/** Lo escrito de una versión nueva. `title` nulo: todavía no se escribió, y se ofrece el de la última. */
export interface LegalDraft {
  docType: LegalDocType;
  /** La última versión que se vio de ese tipo (nula si no había ninguna). */
  seen: number | null;
  title: string | null;
  body: string;
  day: string;
}

export type LegalRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "new"; docType: LegalDocType; seen: number | null }
  | { step: "edit"; draft: LegalDraft }
  | { step: "preview"; draft: LegalDraft }
  | { step: "publish"; draft: LegalDraft; sha: string };

function textOf(form: FormData, name: string, max: number): string {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, max) : "";
}

function draftOf(form: FormData, docType: LegalDocType, seen: number | null): LegalDraft {
  return {
    docType,
    seen,
    title: textOf(form, "title", MAX_TITLE_READ),
    body: textOf(form, "body", MAX_BODY_READ),
    day: textOf(form, "day", MAX_DAY_READ),
  };
}

/**
 * Qué se pidió. `none` si lo que llegó no es un formulario, no trae `do`, lo trae más de una vez, viene
 * desmedido o no se entiende.
 */
export function readLegalForm(form: unknown): LegalRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, type, seenText, sha, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (verb === "cancel" && type === undefined) return { step: "cancel" };
  const docType = TYPES.find((each) => each === type);
  if (docType === undefined || seenText === undefined || !SEEN.test(seenText)) return { step: "none" };
  const seen = seenText === "none" ? null : Number(seenText);
  if (verb === "publish") return sha !== undefined && SHA.test(sha) ? { step: "publish", draft: draftOf(form, docType, seen), sha } : { step: "none" };
  if (sha !== undefined) return { step: "none" };
  switch (verb) {
    case "new":
      return { step: "new", docType, seen };
    case "edit":
      return { step: "edit", draft: draftOf(form, docType, seen) };
    case "preview":
      return { step: "preview", draft: draftOf(form, docType, seen) };
    default:
      return { step: "none" };
  }
}

export type TitleProblem = "required" | "too_long" | "invalid";
export type BodyProblem = "required" | "too_long" | "invalid";
export type DayProblem = "required" | "invalid" | "past" | "too_far";
export interface DraftProblems {
  title?: TitleProblem;
  body?: BodyProblem;
  day?: DayProblem;
}

/** Lo escrito, ya con la forma que se publica (título en NFC y sin espacios a los lados, renglones con `\n`). */
export type CheckedDraft = LegalDraft & { title: string };

/** Lo que tiene que decirse de lo escrito antes de llamar a nadie, o lo escrito ya revisado. */
export function checkDraft(draft: LegalDraft, today: string): { ok: true; draft: CheckedDraft } | { ok: false; problems: DraftProblems } {
  const title = parseLegalTitle(draft.title);
  const body = parseLegalBody(draft.body);
  const day = parseLegalDay(draft.day, today);
  const problems: DraftProblems = {};
  if (!title.ok) problems.title = title.reason === "empty" ? "required" : title.reason;
  if (!body.ok) problems.body = body.reason === "empty" ? "required" : body.reason;
  if (!day.ok) problems.day = day.reason === "empty" ? "required" : day.reason;
  if (!title.ok || !body.ok || !day.ok) return { ok: false, problems };
  return { ok: true, draft: { ...draft, title: title.title, body: body.body, day: day.day } };
}

// ---------------------------------------------------------------------------------------
// Los valores de los botones. Los arma esta tabla y los lee `readLegalForm`.

const seenPart = (seen: number | null) => (seen === null ? "none" : String(seen));

export const legalButton = {
  cancel: () => "cancel",
  new: (docType: LegalDocType, seen: number | null) => `new:${docType}:${seenPart(seen)}`,
  edit: (docType: LegalDocType, seen: number | null) => `edit:${docType}:${seenPart(seen)}`,
  preview: (docType: LegalDocType, seen: number | null) => `preview:${docType}:${seenPart(seen)}`,
  publish: (docType: LegalDocType, seen: number | null, sha: string) => `publish:${docType}:${seenPart(seen)}:${sha}`,
} as const;

// ---------------------------------------------------------------------------------------
// Lo que se pinta.

/** Por qué la vista previa no se publicó: se queda a la vista, con lo escrito, para intentar otra vez. */
export type PreviewFailure = "needs_code" | "stale" | "unavailable";

export type LegalState =
  | { kind: "idle" }
  /** El formulario de una versión nueva, con lo escrito, sus errores y, si alguien publicó antes, el aviso. */
  | { kind: "composing"; draft: LegalDraft; problems: DraftProblems; changed: boolean; attempt: number }
  /**
   * La vista previa, con la huella del texto que se ve, sus bloques ya partidos por el servidor y desde cuándo
   * rige, ya en palabras.
   */
  | { kind: "previewing"; draft: CheckedDraft; sha: string; blocks: LegalBlock[]; when: string; failure: PreviewFailure | null; attempt: number }
  /** No se supo si se publicó, o falta la zona del periodo: se dice arriba de la lista. */
  | { kind: "failed"; reason: "unknown" | "no_zone"; attempt: number };

/**
 * Lo que contestó publicar, ya traducido. `preview` vuelve a pintar la vista previa (la acción la arma de
 * nuevo con el texto que llegó); `compose`, el formulario; `refresh`, si la lista pudo cambiar.
 */
export type PublishOutcome =
  | Leave
  | { kind: "preview"; failure: PreviewFailure; refresh: boolean }
  | { kind: "compose"; seen: number | null; problems: DraftProblems; changed: boolean; refresh: boolean }
  | { kind: "failed"; reason: "unknown" | "no_zone"; refresh: boolean };

export function publishOutcome(result: VersionPublished, seen: number | null): PublishOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
    case "malformed":
      return { kind: "preview", failure: "unavailable", refresh: false };
    case "unknown":
      return { kind: "failed", reason: "unknown", refresh: true };
    case "preview_stale":
      return { kind: "preview", failure: "stale", refresh: false };
    case "answered":
      switch (result.answer) {
        case "published":
          return { kind: "leave", to: ROUTES.legalTexts, notice: "legal_published" };
        case "changed":
          // Alguien publicó antes: se vuelve al formulario, con lo escrito y con la versión que hay ahora.
          return { kind: "compose", seen: result.version, problems: {}, changed: true, refresh: true };
        case "past":
          return { kind: "compose", seen, problems: { day: "past" }, changed: false, refresh: false };
        case "invalid":
          return { kind: "preview", failure: "unavailable", refresh: false };
        case "unavailable":
          return { kind: "failed", reason: "no_zone", refresh: false };
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          // La página vuelve a leer que el código no es reciente, y pinta «Tu código».
          return { kind: "preview", failure: "needs_code", refresh: true };
      }
  }
}
