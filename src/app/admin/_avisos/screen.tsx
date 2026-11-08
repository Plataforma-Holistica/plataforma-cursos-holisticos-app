"use client";

import { type RefObject, useActionState, useEffect, useRef } from "react";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { DataTable } from "@/ui/data-table";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { StatusBadge } from "@/ui/status-badge";
import { Textarea } from "@/ui/textarea";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { billingCodeAction, billingEventsAction } from "./actions";
import { billingButton, type BillingFailure, type BillingState, type CodeState } from "./outcomes";
import { errorText, type BillingRow, type BillingView } from "./rows";

// PA-84 · Los avisos de cobro sin procesar (FL-55; T-303, tercera solicitud): la tabla, del más viejo al más nuevo, con «Reintentar» y «Resolver a mano» en lo
// fallido. El aviso no guarda su cuerpo: lo que hace falta ver se abre en Stripe. Todo funciona sin JavaScript: cada fila es su propio formulario, ligado a la misma
// acción, y el botón dice qué, de qué aviso y con qué revisión. Resolver se confirma en dos pasos, en su fila. En el teléfono solo se consulta (la ficha): las
// acciones se ocultan por debajo del ancho de tableta, sin JavaScript (decisión mía sin confirmar: el cómo).

const text = admin.billingEvents;
const CODE_IDLE: CodeState = { kind: "idle" };
const LIST_IDLE: BillingState = { kind: "idle" };
const CODE_BLOCK_ID = "bloque-avisos-codigo";
const CODE_TITLE_ID = "avisos-codigo-titulo";
const CODE_FIELD_ID = "avisos-codigo";
const LIST_BLOCK_ID = "bloque-avisos-lista";
const CODE_PERMALINK = `${ROUTES.billingEvents}#${CODE_BLOCK_ID}`;
const LIST_PERMALINK = `${ROUTES.billingEvents}#${LIST_BLOCK_ID}`;
const NOTE_MAX = 500;

/** Los avisos con que vuelve una acción que salió bien (`notice.ts`). */
export type DoneNotice = "billing_event_processed" | "billing_event_already_applied" | "billing_event_on_its_way" | "billing_event_resolved";

const DONE: Record<DoneNotice, string> = {
  billing_event_processed: text.done.processed,
  billing_event_already_applied: text.done.alreadyApplied,
  billing_event_on_its_way: text.done.onItsWay,
  billing_event_resolved: text.done.resolved,
};

function failureText(reason: BillingFailure, code: string | null): string {
  switch (reason) {
    case "failed_again":
      return t(text.failedAgain, { error: errorText(code ?? ""), code: code ?? "" });
    case "requeued":
      return t(text.requeued, { error: errorText(code ?? "") });
    case "needs_code":
      return text.needsCode;
    case "missing_note":
      return text.missingNote;
    case "changed":
      return text.changed;
    case "not_failed":
      return text.notFailed;
    case "self":
      return text.self;
    case "not_found":
      return text.notFound;
    case "unavailable":
      return account.common.unavailable;
    case "unknown":
      return text.unknown;
  }
}

const COLUMNS = [
  { key: "date", header: text.columns.date },
  { key: "type", header: text.columns.type },
  { key: "status", header: text.columns.status },
  { key: "attempts", header: text.columns.attempts, numeric: true },
  { key: "error", header: text.columns.error },
  { key: "ids", header: text.columns.ids },
  { key: "actions", header: text.columns.actions },
] as const;

export interface BillingEventsScreenProps {
  view: BillingView;
  done?: DoneNotice | null;
}

export function BillingEventsScreen({ view, done = null }: BillingEventsScreenProps) {
  const [code, codeAction, codePending] = useActionState(billingCodeAction, CODE_IDLE, CODE_PERMALINK);
  const [list, send, pending] = useActionState(billingEventsAction, LIST_IDLE, LIST_PERMALINK);
  const doneBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done !== null && focusIsLost()) doneBox.current?.focus();
  }, [done]);

  const attempt = list.kind === "idle" ? 0 : list.attempt;
  const failure = pending || list.kind !== "failed" ? null : list.reason === "needs_code" && view.canChange ? null : list;
  const result = failure === null ? null : withNote(failureText(failure.reason, failure.code), failure.note);
  const tone = failure !== null && (failure.reason === "unavailable" || failure.reason === "unknown" || failure.reason === "failed_again") ? "danger" : "warning";
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const confirming = list.kind === "confirming" ? list : null;
  const showDone = done !== null && list.kind === "idle" && !pending;

  const rows = view.rows.map((row) => ({
    key: row.key,
    cells: {
      date: (
        <span className="flex flex-col gap-1">
          <span>{row.date}</span>
          <span className="text-caption text-text-2">{row.received}</span>
        </span>
      ),
      type: (
        <span className="flex flex-col gap-1">
          <span>{row.type}</span>
          {row.testMode && <span className="text-caption text-text-2">{text.testMode}</span>}
        </span>
      ),
      status: <StatusBadge tone={row.tone}>{row.status}</StatusBadge>,
      attempts: row.attempts,
      error: row.error === null ? null : <span className="break-words">{row.error}</span>,
      ids: (
        <span className="flex flex-col gap-1 text-body-s break-all">
          <span>{t(text.event, { id: row.eventId })}</span>
          <span className="text-text-2">{t(text.object, { id: row.objectId })}</span>
          <a
            href={row.stripeHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(text.openInStripeLabel, { id: row.eventId })}
            className="text-accent underline underline-offset-2"
          >
            {text.openInStripe}
          </a>
        </span>
      ),
      actions: (
        <RowActions
          row={row}
          canChange={view.canChange}
          asked={confirming !== null && confirming.asked.event === row.id ? confirming : null}
          answer={answer}
          action={send}
          pending={pending}
        />
      ),
    },
  }));

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
      {!view.canChange && (
        <div className="hidden md:block">
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
        </div>
      )}

      <section ref={block} id={LIST_BLOCK_ID} aria-label={text.listCaption} tabIndex={-1} className="flex flex-col gap-6 outline-none">
        <p className="text-body-s text-text-2 md:hidden">{text.phoneOnly}</p>
        {!view.canChange && <p className="hidden text-body-s text-text-2 md:block">{text.changeLocked}</p>}
        {showDone && (
          <div ref={doneBox} tabIndex={-1} className="outline-none">
            <InlineAlert tone="success">{done === null ? null : DONE[done]}</InlineAlert>
          </div>
        )}
        <BlockResult message={result} tone={tone} pending={pending} pendingText={text.working} answer={answer} spoken={spoken} />
        <DataTable caption={text.listCaption} captionHidden columns={COLUMNS} rows={rows} empty={text.empty} scroll />
        {view.more !== null && <p className="text-body-s text-text-2">{view.more}</p>}
      </section>

      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}

/** El mensaje, y la nota que se había escrito en la confirmación que ya se cerró: así no se pierde. */
function withNote(message: string, note: string | undefined): string {
  return note === undefined || note.trim() === "" ? message : `${message} ${t(admin.alerts.written, { text: note.trim() })}`;
}

function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

interface RowActionsProps {
  row: BillingRow;
  canChange: boolean;
  asked: Extract<BillingState, { kind: "confirming" }> | null;
  answer: RefObject<HTMLDivElement | null>;
  action: (form: FormData) => void;
  pending: boolean;
}

function RowActions({ row, canChange, asked, answer, action, pending }: RowActionsProps) {
  if (row.offer === "waits") return <span className="text-body-s text-text-2">{text.waitsT307}</span>;
  if (row.offer === "on_its_way") return <span className="text-body-s text-text-2">{text.onItsWay}</span>;
  if (row.offer === "yours") return <span className="text-body-s text-text-2">{text.yours}</span>;
  if (!canChange) return null;
  return (
    // En el teléfono solo se consulta: las acciones no se pintan por debajo del ancho de tableta.
    <form action={action} noValidate className="hidden min-w-64 flex-col gap-3 md:flex">
      {asked !== null ? (
        <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
          <p className="font-semibold">{text.resolveTitle}</p>
          <p className="text-body-s text-text-2">{text.resolveBody}</p>
          <Textarea
            key={`nota-${asked.attempt}`}
            id={`avisos-nota-${row.id}`}
            label={text.noteLabel}
            name="note"
            hint={t(text.noteHint, { max: String(NOTE_MAX) })}
            defaultValue={asked.note}
            maxLength={NOTE_MAX}
            error={asked.asked.problem === null ? undefined : text.missingNote}
          />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" name="do" value={billingButton.resolve(row.id, asked.asked.revision)} size="md" disabled={pending}>
              {text.confirmResolve}
            </Button>
            <Button type="submit" name="do" value={billingButton.cancel()} variant="secondary" size="md" disabled={pending}>
              {text.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button type="submit" name="do" value={billingButton.retry(row.id, row.revision)} size="md" disabled={pending}>
            {text.retry} <span className="sr-only">{t(text.ofEvent, { id: row.eventId })}</span>
          </Button>
          <Button type="submit" name="do" value={billingButton.askResolve(row.id, row.revision)} variant="secondary" size="md" disabled={pending}>
            {text.resolve} <span className="sr-only">{t(text.ofEvent, { id: row.eventId })}</span>
          </Button>
        </div>
      )}
    </form>
  );
}
