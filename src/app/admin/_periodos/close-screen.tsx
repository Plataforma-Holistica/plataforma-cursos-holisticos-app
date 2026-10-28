"use client";

import { CircleCheck, CircleDashed } from "lucide";
import { useActionState, useEffect, useRef } from "react";

import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import { periodClosePath, ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { SPACE } from "@/ui/cx";
import { DataTable } from "@/ui/data-table";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { StatTile } from "@/ui/stat-tile";
import { StatusBadge } from "@/ui/status-badge";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { closeAction, downloadAction, periodCodeAction } from "./actions";
import { FAILURES, toneOf } from "./failures";
import { periodsButton, UNDERSTOOD, type CloseState, type CodeState, type DownloadState } from "./outcomes";
import type { CloseView, RunResult } from "./rows";

// PA-80 · El ensayo y el cierre de un periodo: ver el reparto antes de congelarlo, tantas veces como
// haga falta, y cerrarlo una sola vez, a conciencia (RF-502, RF-503, RF-509). El ensayo no congela nada;
// el cierre congela puntos, bote, porcentaje y pagos (RN-09), y no se deshace. Ensayar y cerrar corren
// mientras la pantalla espera: tardan segundos (05 §14.4).
//
// Todo funciona sin JavaScript. Ensayar y cerrar son un solo estado: cerrar abre el diálogo sin llamar a
// nadie, y pide marcar «Entiendo que no se puede deshacer». Descargar tiene su propio estado: el archivo
// vuelve en él como dirección de datos, y así no viaja con los demás formularios (decisión mía sin
// confirmar del 2026-10-27; bajo administración no hay rutas que lo sirvan).

const text = admin.periods;
const CODE_IDLE: CodeState = { kind: "idle" };
const CLOSE_IDLE: CloseState = { kind: "idle" };
const DOWNLOAD_IDLE: DownloadState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const CODE_BLOCK_ID = "bloque-cierre-codigo";
const CODE_TITLE_ID = "cierre-codigo-titulo";
const CODE_FIELD_ID = "cierre-codigo";
const CLOSE_BLOCK_ID = "bloque-cierre-ensayo";
const CLOSE_HEADING_ID = "cierre-ensayo-titulo";
const DOWNLOAD_BLOCK_ID = "bloque-cierre-descarga";
const DOWNLOAD_HEADING_ID = "cierre-descarga-titulo";
const UNDERSTOOD_ID = "cierre-entiendo";

/** Los avisos con que vuelve una decisión que salió bien (`notice.ts`). */
export type CloseNotice = "period_rehearsed" | "period_closed";
const DONE: Record<CloseNotice, string> = {
  period_rehearsed: text.done.periodRehearsed,
  period_closed: text.done.periodClosed,
};

export interface CloseScreenProps {
  view: CloseView;
  done?: CloseNotice | null;
}

export function CloseScreen({ view, done = null }: CloseScreenProps) {
  const page = periodClosePath(view.periodId);
  const [code, codeAction, codePending] = useActionState(periodCodeAction.bind(null, { period: view.periodId, page: "close" }), CODE_IDLE, `${page}#${CODE_BLOCK_ID}`);
  const [state, send, pending] = useActionState(closeAction, CLOSE_IDLE, `${page}#${CLOSE_BLOCK_ID}`);
  const [file, sendDownload, downloading] = useActionState(downloadAction.bind(null, view.periodId), DOWNLOAD_IDLE, `${page}#${DOWNLOAD_BLOCK_ID}`);
  const doneBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done !== null && (document.activeElement === null || document.activeElement === document.body)) doneBox.current?.focus();
  }, [done]);

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const failure = pending || state.kind !== "failed" ? null : state.reason === "needs_code" && view.canChange ? null : state.reason;
  const result = failure === null ? null : FAILURES[failure];
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const showDone = done !== null && state.kind === "idle" && !pending;
  const confirming = state.kind === "confirming" && view.close.kind === "ready" ? state : null;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-3">
        <BackLink href={view.panelHref}>{view.name}</BackLink>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-h1">{text.closeTitle}</h1>
          <StatusBadge tone={view.tone}>{view.status}</StatusBadge>
        </div>
        <p className="text-text-2">{view.lastRehearsal}</p>
        {view.closedLine !== null && <p>{view.closedLine}</p>}
      </div>

      {!view.canChange && (view.close.kind !== "closed" || view.download.kind === "locked") && (
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

      {showDone && (
        <div ref={doneBox} tabIndex={-1} className="outline-none">
          <InlineAlert tone="success">{done === null ? null : DONE[done]}</InlineAlert>
        </div>
      )}

      {view.close.kind !== "closed" && (
        <section ref={block} id={CLOSE_BLOCK_ID} aria-labelledby={CLOSE_HEADING_ID} tabIndex={-1} className="flex flex-col gap-6 outline-none">
          <h2 id={CLOSE_HEADING_ID} className="text-h2">
            {text.resultTitle}
          </h2>
          <BlockResult message={result} tone={failure === null ? "warning" : toneOf(failure)} pending={pending} pendingText={text.rehearsing} answer={answer} spoken={spoken} />
          {view.rehearse !== null && (
            <form action={send} noValidate>
              <Button type="submit" name="do" value={view.rehearse} loading={pending} loadingLabel={text.rehearsing}>
                {text.rehearse}
              </Button>
            </form>
          )}
          {view.rehearsal !== null && (
            <>
              <InlineAlert tone={view.rehearsal.failed ? "danger" : "neutral"}>{view.rehearsal.banner}</InlineAlert>
              {!view.rehearsal.failed && <Result result={view.rehearsal} />}
            </>
          )}

          <div className="flex flex-col gap-3">
            <h3 className="text-h3">{text.checklistTitle}</h3>
            <ul className="flex flex-col gap-2">
              {view.checks.map((check) => (
                <li key={check.label} className="flex flex-wrap items-start gap-2">
                  <Icon icon={check.done ? CircleCheck : CircleDashed} className={check.done ? "text-success" : "text-warning"} />
                  <span>
                    <span className="sr-only">{check.done ? text.checkDone : text.checkMissing}</span>
                    {SPACE}
                    {check.label}
                  </span>
                  {!check.done && check.href !== undefined && <TextLink href={check.href}>{text.goToAlerts}</TextLink>}
                </li>
              ))}
            </ul>
          </div>

          {view.close.kind === "waits" && <p className="text-text-2">{text.closeWaits}</p>}
          {view.close.kind === "ready" && confirming === null && (
            <form action={send} noValidate>
              <Button type="submit" variant="danger" name="do" value={view.close.button}>
                {text.closeButton}
              </Button>
            </form>
          )}
          {confirming !== null && (
            <form action={send} noValidate>
              <Dialog
                title={view.dialogTitle}
                irreversible
                busy={pending}
                extra={
                  <Checkbox
                    key={`entiendo-${confirming.attempt}`}
                    id={UNDERSTOOD_ID}
                    name="understood"
                    value={UNDERSTOOD}
                    label={text.understood}
                    error={confirming.missingUnderstood ? text.missingUnderstood : undefined}
                  />
                }
                cancel={
                  <Button type="submit" variant="secondary" name="do" value={periodsButton.cancel()} disabled={pending}>
                    {text.keepReviewing}
                  </Button>
                }
                confirm={
                  <Button type="submit" variant="danger" name="do" value={periodsButton.close(view.periodId)} loading={pending} loadingLabel={text.closing}>
                    {text.confirmClose}
                  </Button>
                }
              >
                <p>{t(text.dialogBody)}</p>
                <p>{text.dialogUndo}</p>
              </Dialog>
            </form>
          )}
        </section>
      )}

      {view.result !== null && (
        <section aria-labelledby="cierre-resultado-titulo" className="flex flex-col gap-6">
          <h2 id="cierre-resultado-titulo" className="text-h2">
            {text.closedTitle}
          </h2>
          <Result result={view.result} />
        </section>
      )}

      {view.download.kind !== "none" && (
        <section id={DOWNLOAD_BLOCK_ID} aria-labelledby={DOWNLOAD_HEADING_ID} className="flex flex-col gap-4">
          <h2 id={DOWNLOAD_HEADING_ID} className="text-h2">
            {text.downloadTitle}
          </h2>
          <p className="text-text-2">{t(text.downloadBody)}</p>
          {view.download.kind === "missing" && <InlineAlert tone="danger">{text.noExport}</InlineAlert>}
          {view.download.kind === "offered" && <Download state={file} pending={downloading} button={view.download.button} action={sendDownload} canChange={view.canChange} />}
        </section>
      )}

      <p className="text-body-s">
        <TextLink href={ROUTES.periods}>{text.backToPeriods}</TextLink>
      </p>
    </main>
  );
}

function Result({ result }: { result: RunResult }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={result.pool.label} value={result.pool.value} />
        <StatTile label={result.poolPercent.label} value={result.poolPercent.value} context={result.poolPercent.context} />
        <StatTile label={result.unconsumed.label} value={result.unconsumed.value} context={result.unconsumed.context} />
        <StatTile
          label={text.sumTitle}
          value={result.sum.value}
          context={result.sum.ok ? (result.sum.carried === null ? text.sumOk : `${text.sumOk} ${result.sum.carried}`) : text.sumOff}
          tone={result.sum.ok ? undefined : "attention"}
        />
      </div>
      {result.nothingAssigned && <InlineAlert tone="warning">{text.nothingAssigned}</InlineAlert>}
      <DataTable
        caption={t(text.teachersCaption)}
        scroll
        columns={[
          { key: "name", header: t(text.teacherColumns.teacher) },
          { key: "assigned", header: text.teacherColumns.assigned, numeric: true },
          { key: "unconsumed", header: text.teacherColumns.unconsumed, numeric: true },
          { key: "total", header: text.teacherColumns.total, numeric: true },
          { key: "bonus", header: text.teacherColumns.bonus, numeric: true },
          { key: "remains", header: text.teacherColumns.remains },
        ]}
        rows={result.teachers.map((row) => ({ key: row.key, cells: { ...row } }))}
        totals={{ name: text.total, ...result.totals, remains: "" }}
        empty={text.teachersEmpty}
      />
    </div>
  );
}

interface DownloadProps {
  state: DownloadState;
  pending: boolean;
  button: string;
  action: (form: FormData) => void;
  canChange: boolean;
}

function Download({ state, pending, button, action, canChange }: DownloadProps) {
  const link = useRef<HTMLAnchorElement>(null);
  const saved = useRef(0);
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  // Con JavaScript, el archivo se guarda solo una vez por respuesta; el enlace queda para guardarlo otra vez.
  useEffect(() => {
    if (state.kind !== "file" || saved.current === attempt) return;
    saved.current = attempt;
    link.current?.click();
  }, [state.kind, attempt]);
  const failure = pending || state.kind !== "failed" ? null : state.reason === "needs_code" && canChange ? null : state.reason;
  return (
    <div className="flex flex-col gap-3">
      {failure !== null && (
        <InlineAlert key={`descarga-${attempt}`} tone={toneOf(failure)} live>
          {FAILURES[failure]}
        </InlineAlert>
      )}
      {!pending && state.kind === "file" && (
        <InlineAlert key={`archivo-${attempt}`} tone="success" live>
          {t(plural(state.rows, text.downloadReady), { count: state.rows })}
          {SPACE}
          <a ref={link} href={state.href} download={state.filename} className="text-accent underline">
            {text.saveFile}
          </a>
        </InlineAlert>
      )}
      {canChange && (
        <form action={action} noValidate>
          <Button type="submit" variant="secondary" name="do" value={button} loading={pending} loadingLabel={text.downloading}>
            {text.download}
          </Button>
        </form>
      )}
    </div>
  );
}
