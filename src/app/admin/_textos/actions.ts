"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { longDate, productDay } from "@/app/_lib/dates";
import { cookieJar } from "@/app/_lib/request-context";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { bodyFingerprint, giveLegalCode, legalBlocks, publishLegalVersion } from "@/services/legal/legal-admin";

import {
  checkDraft,
  legalCodeOutcome,
  publishOutcome,
  readLegalForm,
  type CheckedDraft,
  type CodeState,
  type LegalState,
  type PreviewFailure,
} from "./outcomes";

// Las acciones de PA-89, los textos legales (T-110; RF-713). Ninguna decide quién puede: el servicio corre
// la guarda y la base vuelve a comprobar que quien pide tenga configuración y un código reciente. Aquí se
// lee qué botón se pulsó y lo escrito, se llama al servicio y se traduce su respuesta con la tabla de la
// pantalla. Del estado anterior solo se lee el número de intento.

/**
 * Dar el código otra vez, para que publicar pase su puerta. Un código sin forma no llega al servicio: no es
 * un intento, y no cuenta en el freno. Verificado, se redirige a esta misma página en vez de pintarla:
 * recargar no reenvía el código.
 */
export async function legalCodeAction(previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = legalCodeOutcome(await giveLegalCode(jar, code));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * La vista previa de lo escrito: la huella del texto que se ve, sus bloques y desde cuándo rige, armados
 * aquí. Un día se dice al mediodía de la zona del producto, para que ninguna zona lo mueva de fecha.
 */
function previewOf(draft: CheckedDraft, today: string, failure: PreviewFailure | null, attempt: number): LegalState {
  const when = draft.day === today ? admin.legal.preview.today : t(admin.legal.preview.since, { date: longDate(`${draft.day}T12:00:00-06:00`) });
  return { kind: "previewing", draft, sha: bodyFingerprint(draft.body), blocks: legalBlocks(draft.body), when, failure, attempt };
}

/**
 * Una versión nueva. «Nueva versión», «Seguir editando» y «Ver cómo queda» no llaman a nadie: lo escrito se
 * revisa aquí, con las reglas del dominio, y contra el día de hoy en la zona del producto (la base vuelve a
 * revisarlo con la del periodo, y manda). «Publicar» lleva la versión que se vio y la huella del texto de la
 * vista previa.
 */
export async function legalAction(previous: LegalState, form: FormData): Promise<LegalState> {
  const request = readLegalForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const today = productDay(new Date());

  if (request.step === "new") {
    const draft = { docType: request.docType, seen: request.seen, title: null, body: "", day: today };
    return { kind: "composing", draft, problems: {}, changed: false, attempt };
  }
  if (request.step === "edit") return { kind: "composing", draft: request.draft, problems: {}, changed: false, attempt };

  const checked = checkDraft(request.draft, today);
  if (!checked.ok) return { kind: "composing", draft: request.draft, problems: checked.problems, changed: false, attempt };
  if (request.step === "preview") return previewOf(checked.draft, today, null, attempt);

  const jar = await cookieJar();
  const { draft } = checked;
  const outcome = publishOutcome(
    await publishLegalVersion(jar, {
      docType: draft.docType,
      title: draft.title,
      body: draft.body,
      day: draft.day,
      seenVersion: draft.seen,
      seenSha: request.sha,
    }),
    draft.seen,
  );
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  if (outcome.refresh) refresh();
  switch (outcome.kind) {
    case "preview":
      return previewOf(draft, today, outcome.failure, attempt);
    case "compose":
      return { kind: "composing", draft: { ...draft, seen: outcome.seen }, problems: outcome.problems, changed: outcome.changed, attempt };
    case "failed":
      return { kind: "failed", reason: outcome.reason, attempt };
  }
}
