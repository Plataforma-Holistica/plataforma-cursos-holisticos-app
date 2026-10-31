import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { parseDraftText } from "@/domain/catalog/draft-text";
import { resourceTypeOf, type ResourceKind } from "@/domain/catalog/resource-content";

import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";
import type { ResourceFiles } from "@/services/media/resource-files";

// Los recursos del borrador de un curso (RF-605; T-404, segunda solicitud). Quién puede lo decide la base; aquí
// se decide a quién se le pregunta qué, y en qué orden.
//
// Subir son tres pasos, porque el archivo va del navegador a la cubeta (Vercel corta todo envío en 4.5 MB):
// `beginResource` reserva la fila y firma la ruta que la base contestó; el navegador sube; `confirmResource`
// lee el contenido del objeto y le pregunta a la base, que compara lo que Storage guardó.
//
// Las respuestas se validan ya confirmada la transacción (`store.ts`): `rejected` y `expired` borran la fila.
// Lo que sobra se borra aparte, y una falla ahí no tumba lo que ya se hizo: se reporta, y el repaso lo alcanza.

const OPEN = ["not_found", "not_editable", "suspended", "not_teacher"] as const;
export const BEGIN_ANSWERS = ["started", "invalid", "too_large", "too_many", "throttled", "unavailable", ...OPEN] as const;
export const FILE_ANSWERS = ["found", ...OPEN] as const;
export const CONFIRM_ANSWERS = ["ready", "rejected", "expired", "not_uploaded", "unavailable", ...OPEN] as const;
export const MOVE_ANSWERS = ["moved", "changed", "invalid", ...OPEN] as const;
export const REMOVE_ANSWERS = ["deleted", "changed", ...OPEN] as const;
export const REJECT_REASONS = ["type", "size", "content"] as const;

export type BeginAnswer = (typeof BEGIN_ANSWERS)[number];
export type FileAnswer = (typeof FILE_ANSWERS)[number];
export type ConfirmAnswer = (typeof CONFIRM_ANSWERS)[number];
export type MoveAnswer = (typeof MOVE_ANSWERS)[number];
export type RemoveAnswer = (typeof REMOVE_ANSWERS)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface ResourcesStore {
  begin: (
    claims: VerifiedClaims,
    input: { course: string; lesson: string | null; title: string; kind: ResourceKind; mime: string; size: number },
  ) => Promise<{ answer: BeginAnswer; resource: string | null; path: string | null }>;
  file: (claims: VerifiedClaims, input: { course: string; resource: string }) => Promise<{ answer: FileAnswer; path: string | null; mime: string | null }>;
  confirm: (
    claims: VerifiedClaims,
    input: { course: string; resource: string; contentOk: boolean | null },
  ) => Promise<{ answer: ConfirmAnswer; reason: RejectReason | null }>;
  move: (claims: VerifiedClaims, input: { course: string; resource: string; seenPosition: number; toPosition: number }) => Promise<MoveAnswer>;
  remove: (claims: VerifiedClaims, input: { course: string; resource: string; seen: number }) => Promise<RemoveAnswer>;
  unused: (claims: VerifiedClaims, course: string) => Promise<string[]>;
}

export interface DraftResourcesDeps {
  store: ResourcesStore;
  files: ResourceFiles;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
}

type Refused = { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> } | { kind: "unknown" } | { kind: "invalid" };
export type BeginResult = { kind: "started"; resource: string; url: string; mime: string } | { kind: Exclude<BeginAnswer, "started"> } | Refused;
export type ConfirmResult = { kind: "rejected"; reason: RejectReason | null } | { kind: Exclude<ConfirmAnswer, "rejected"> } | Refused;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (value: string) => ID.test(value);
const isCount = (value: number) => Number.isSafeInteger(value) && value >= 1;

export function createDraftResources(deps: DraftResourcesDeps) {
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

  /** Borra lo que ninguna fila de ese curso nombra. Lo llama quien acaba de quitar o borrar algo. */
  async function cleanUp(claims: VerifiedClaims, course: string): Promise<void> {
    try {
      const paths = await deps.store.unused(claims, course);
      if (paths.length > 0) await deps.files.remove(paths);
    } catch {
      await deps.report("resource_cleanup_failed");
    }
  }

  function beginResource(
    reader: CookieReader,
    input: { course: string; lesson: string | null; title: string | null; fileName: string; size: number },
  ): Promise<BeginResult> {
    const type = resourceTypeOf(input.fileName);
    const title = parseDraftText("lessonTitle", input.title);
    const formed = isId(input.course) && (input.lesson === null || isId(input.lesson)) && type !== null && title.ok && title.text !== null && isCount(input.size);
    return guarded<BeginResult>(reader, formed, async (claims) => {
      if (type === null || !title.ok || title.text === null) return { kind: "invalid" };
      const begun = await deps.store.begin(claims, {
        course: input.course,
        lesson: input.lesson,
        title: title.text,
        kind: type.kind,
        mime: type.mime,
        size: input.size,
      });
      if (begun.answer !== "started") return { kind: begun.answer };
      if (begun.resource === null || begun.path === null) throw new Error("started without a path");
      const url = await deps.files.signUpload(begun.path);
      if (url === null) {
        // La fila ocuparía lugar y freno hasta que venciera. Acaba de nacer: su revisión es 1.
        await deps.store.remove(claims, { course: input.course, resource: begun.resource, seen: 1 });
        await deps.report("resource_upload_unavailable");
        return { kind: "unknown" };
      }
      return { kind: "started", resource: begun.resource, url, mime: type.mime };
    });
  }

  function confirmResource(reader: CookieReader, input: { course: string; resource: string }): Promise<ConfirmResult> {
    return guarded<ConfirmResult>(reader, isId(input.course) && isId(input.resource), async (claims) => {
      const file = await deps.store.file(claims, input);
      if (file.answer !== "found") return { kind: file.answer };
      if (file.path === null || file.mime === null) throw new Error("found without a path");
      const contentOk = await deps.files.contentOk(file.path, file.mime);
      const confirmed = await deps.store.confirm(claims, { ...input, contentOk });
      if (confirmed.answer === "rejected" || confirmed.answer === "expired") await cleanUp(claims, input.course);
      return confirmed.answer === "rejected" ? { kind: "rejected", reason: confirmed.reason } : { kind: confirmed.answer };
    });
  }

  function removeResource(reader: CookieReader, input: { course: string; resource: string; seen: number }) {
    const formed = isId(input.course) && isId(input.resource) && isCount(input.seen);
    return guarded<{ kind: RemoveAnswer }>(reader, formed, async (claims) => {
      const answer = await deps.store.remove(claims, input);
      if (answer === "deleted") await cleanUp(claims, input.course);
      return { kind: answer };
    });
  }

  function moveResource(reader: CookieReader, input: { course: string; resource: string; seenPosition: number; toPosition: number }) {
    const formed = isId(input.course) && isId(input.resource) && isCount(input.seenPosition) && isCount(input.toPosition);
    return guarded<{ kind: MoveAnswer }>(reader, formed, async (claims) => ({ kind: await deps.store.move(claims, input) }));
  }

  return { beginResource, confirmResource, removeResource, moveResource, cleanUp };
}
