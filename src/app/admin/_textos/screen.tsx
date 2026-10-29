"use client";

import { useActionState, useEffect, useRef } from "react";

import { LegalBody } from "@/app/_lib/legal-body";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { LEGAL_BODY_MAX_LENGTH } from "@/services/legal/field-rules";
import type { LegalDocType } from "@/services/legal/legal-admin";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { SPACE } from "@/ui/cx";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextField } from "@/ui/text-field";
import { Textarea } from "@/ui/textarea";
import { TextLink } from "@/ui/text-link";

import { CodeBlock } from "../_lib/code-block";
import { legalAction, legalCodeAction } from "./actions";
import {
  legalButton,
  type BodyProblem,
  type CodeState,
  type DayProblem,
  type LegalState,
  type PreviewFailure,
  type TitleProblem,
} from "./outcomes";
import type { DocumentView, LegalView } from "./rows";

// PA-89 · Los textos legales (`/admin/textos-legales`; RF-713, RF-108; FL-57; T-110). Una sección por texto,
// con lo que rige, lo programado y todas sus versiones; «Nueva versión» abre en su lugar el formulario, y «Ver
// cómo queda» la vista previa con la consecuencia de ese texto. Funciona sin JavaScript.
//
// La confirmación va en el bloque, con la vista previa a la vista, y no en un diálogo: uno modal taparía el
// texto que se está revisando (decisión mía sin confirmar del 2026-10-28). Publicar se ofrece solo si la
// página leyó que el código de quien mira es reciente y que la base sabe qué día es hoy.

const text = admin.legal;
const CODE_IDLE: CodeState = { kind: "idle" };
const LEGAL_IDLE: LegalState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const CODE_BLOCK_ID = "bloque-textos-codigo";
const LIST_BLOCK_ID = "bloque-textos-lista";
const CODE_TITLE_ID = "textos-codigo-titulo";
const CODE_FIELD_ID = "textos-codigo";
const CODE_PERMALINK = `${ROUTES.legalTexts}#${CODE_BLOCK_ID}`;
const LIST_PERMALINK = `${ROUTES.legalTexts}#${LIST_BLOCK_ID}`;
const TITLE_FIELD_ID = "textos-titulo";
const BODY_FIELD_ID = "textos-cuerpo";
const DAY_FIELD_ID = "textos-dia";
const PREVIEW_HEADING_ID = "textos-vista-previa";

const TITLE_ERRORS: Record<TitleProblem, string> = {
  required: text.problems.titleRequired,
  too_long: text.problems.titleTooLong,
  invalid: text.problems.titleInvalid,
};
const BODY_ERRORS: Record<BodyProblem, string> = {
  required: text.problems.bodyRequired,
  too_long: text.problems.bodyTooLong,
  invalid: text.problems.bodyInvalid,
};
const DAY_ERRORS: Record<DayProblem, string> = {
  required: text.problems.dayRequired,
  invalid: text.problems.dayInvalid,
  past: text.problems.dayPast,
  too_far: text.problems.dayTooFar,
};
const PREVIEW_FAILURES: Record<PreviewFailure, string> = {
  needs_code: text.failures.needsCode,
  stale: text.failures.stale,
  unavailable: text.failures.unavailable,
};

/** Lo que pasa al publicar cada texto (PA-89, H-40): quién vuelve a aceptar lo decide la base por el tipo. */
const CONSEQUENCES: Record<LegalDocType, string> = {
  terms: text.consequences.terms,
  student_privacy_notice: text.consequences.studentPrivacyNotice,
  teacher_privacy_notice: t(text.consequences.teacherPrivacyNotice),
  community_policy: text.consequences.communityPolicy,
  refund_policy: text.consequences.refundPolicy,
  teacher_agreement: t(text.consequences.teacherAgreement),
  license_annex: text.consequences.licenseAnnex,
  course_history_consent: text.consequences.courseHistoryConsent,
  recurring_charge_consent: text.consequences.recurringChargeConsent,
};

export interface LegalScreenProps {
  view: LegalView;
  /** Se acaba de publicar una versión (el aviso de la cookie, ya aceptado por la página). */
  done: boolean;
}

export function LegalScreen({ view, done }: LegalScreenProps) {
  const [code, codeAction, codePending] = useActionState(legalCodeAction, CODE_IDLE, CODE_PERMALINK);
  const [state, send, pending] = useActionState(legalAction, LEGAL_IDLE, LIST_PERMALINK);
  const canPublish = view.canChange && view.today !== null;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
      {done && state.kind === "idle" && (
        <InlineAlert tone="success" live>
          {text.published}
        </InlineAlert>
      )}
      {!view.canChange && (
        <CodeBlock
          blockId={CODE_BLOCK_ID}
          titleId={CODE_TITLE_ID}
          fieldId={CODE_FIELD_ID}
          body={text.codeBody}
          notAvailable={text.codeNotAvailable}
          state={code}
          action={codeAction}
          pending={codePending}
        />
      )}
      {view.today === null && <InlineAlert tone="warning">{text.noZone}</InlineAlert>}
      <section id={LIST_BLOCK_ID} aria-label={text.title} className="flex flex-col gap-8">
        {!pending && state.kind === "failed" && (
          <InlineAlert key={`fallo-${state.attempt}`} tone="danger" live>
            {state.reason === "no_zone" ? text.noZone : text.failures.unknown}
          </InlineAlert>
        )}
        {view.documents.map((document) => (
          <DocumentSection
            key={document.docType}
            document={document}
            state={state}
            send={send}
            pending={pending}
            canPublish={canPublish}
          />
        ))}
      </section>
      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}

interface SectionProps {
  document: DocumentView;
  state: LegalState;
  send: (form: FormData) => void;
  pending: boolean;
  canPublish: boolean;
}

function DocumentSection({ document, state, send, pending, canPublish }: SectionProps) {
  const headingId = `textos-${document.docType}`;
  const open = (state.kind === "composing" || state.kind === "previewing") && state.draft.docType === document.docType;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h2 id={headingId} className="text-h3">
        {document.name}
      </h2>
      <p>{document.current}</p>
      {document.scheduled.map((line) => (
        <p key={line} className="text-text-2">
          {line}
        </p>
      ))}
      {open && state.kind === "composing" && <Composer document={document} state={state} send={send} pending={pending} />}
      {open && state.kind === "previewing" && <Preview document={document} state={state} send={send} pending={pending} />}
      {!open && canPublish && (
        <form action={send}>
          <Button type="submit" variant="secondary" name="do" value={legalButton.new(document.docType, document.lastVersion)} disabled={pending}>
            {text.newVersion}
            {SPACE}
            <span className="sr-only">{t(text.of, { name: document.name })}</span>
          </Button>
        </form>
      )}
      {document.versions.length > 0 && (
        <details>
          <summary className="cursor-pointer">{text.versionsTitle}</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {document.versions.map((version) => (
              <li key={version.id}>
                {t(text.versionLine, { label: version.label, state: version.stateText, since: version.since })}
                {SPACE}
                <TextLink href={version.href}>{text.viewText}</TextLink>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Composer({ document, state, send, pending }: { document: DocumentView; state: Extract<LegalState, { kind: "composing" }>; send: (form: FormData) => void; pending: boolean }) {
  const { draft, problems } = state;
  const titleField = useRef<HTMLDivElement>(null);
  const errors: FormError[] = [
    ...(problems.title ? [{ fieldId: TITLE_FIELD_ID, message: TITLE_ERRORS[problems.title] }] : []),
    ...(problems.body ? [{ fieldId: BODY_FIELD_ID, message: BODY_ERRORS[problems.body] }] : []),
    ...(problems.day ? [{ fieldId: DAY_FIELD_ID, message: DAY_ERRORS[problems.day] }] : []),
  ];
  const fresh = errors.length === 0 && !state.changed;

  // Abierto el formulario (o vuelto a él sin errores), el foco va al título; con errores lo toma su resumen.
  useEffect(() => {
    if (fresh) titleField.current?.querySelector("input")?.focus();
  }, [fresh, state.attempt]);

  return (
    <form action={send} noValidate className="flex flex-col gap-6">
      <h3 className="text-body-l font-semibold">{t(text.compose.title, { name: document.name })}</h3>
      <FormErrorSummary errors={errors} attempt={state.attempt} />
      {state.changed && (
        <InlineAlert key={`cambio-${state.attempt}`} tone="warning" live>
          {text.failures.changed}
        </InlineAlert>
      )}
      <div ref={titleField} key={`titulo-${state.attempt}`}>
        <TextField
          id={TITLE_FIELD_ID}
          label={text.compose.titleLabel}
          name="title"
          autoComplete="off"
          defaultValue={draft.title ?? document.lastTitle}
          error={problems.title ? TITLE_ERRORS[problems.title] : undefined}
        />
      </div>
      <Textarea
        key={`cuerpo-${state.attempt}`}
        id={BODY_FIELD_ID}
        label={text.compose.bodyLabel}
        name="body"
        hint={text.compose.bodyHint}
        rows={16}
        maxLength={LEGAL_BODY_MAX_LENGTH}
        defaultValue={draft.body}
        error={problems.body ? BODY_ERRORS[problems.body] : undefined}
      />
      <TextField
        key={`dia-${state.attempt}`}
        id={DAY_FIELD_ID}
        type="date"
        label={text.compose.dayLabel}
        name="day"
        autoComplete="off"
        hint={text.compose.dayHint}
        defaultValue={draft.day}
        error={problems.day ? DAY_ERRORS[problems.day] : undefined}
      />
      {/* «Ver cómo queda» va primero: es el que envía Enter desde un campo. */}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="do" value={legalButton.preview(draft.docType, draft.seen)} loading={pending} loadingLabel={text.working}>
          {text.compose.preview}
        </Button>
        <Button type="submit" variant="secondary" name="do" value={legalButton.cancel()} disabled={pending}>
          {text.compose.cancel}
        </Button>
      </div>
    </form>
  );
}

function Preview({ document, state, send, pending }: { document: DocumentView; state: Extract<LegalState, { kind: "previewing" }>; send: (form: FormData) => void; pending: boolean }) {
  const { draft } = state;
  const heading = useRef<HTMLHeadingElement>(null);
  const next = (draft.seen ?? 0) + 1;

  // La vista previa toma el foco al aparecer: lo pulsado se fue con el formulario.
  useEffect(() => {
    heading.current?.focus();
  }, [state.attempt]);

  return (
    <form action={send} className="flex flex-col gap-6">
      <h3 id={PREVIEW_HEADING_ID} ref={heading} tabIndex={-1} className="text-body-l font-semibold">
        {t(text.preview.title, { name: document.name, version: next })}
      </h3>
      {!pending && state.failure !== null && (
        <InlineAlert key={`fallo-${state.attempt}`} tone="danger" live>
          {PREVIEW_FAILURES[state.failure]}
        </InlineAlert>
      )}
      <InlineAlert tone="warning">
        <p>{CONSEQUENCES[draft.docType]}</p>
        <p>{text.preview.irreversible}</p>
      </InlineAlert>
      <p className="text-text-2">{state.when}</p>
      <div className="flex flex-col gap-4 rounded-md border border-border p-4">
        <p className="text-h2">{draft.title}</p>
        <LegalBody title={draft.title} blocks={state.blocks} />
      </div>
      <input type="hidden" name="title" value={draft.title} />
      <input type="hidden" name="body" value={draft.body} />
      <input type="hidden" name="day" value={draft.day} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="do" value={legalButton.publish(draft.docType, draft.seen, state.sha)} loading={pending} loadingLabel={text.working}>
          {t(text.compose.publish, { version: next })}
        </Button>
        <Button type="submit" variant="secondary" name="do" value={legalButton.edit(draft.docType, draft.seen)} disabled={pending}>
          {text.compose.editAgain}
        </Button>
      </div>
    </form>
  );
}
