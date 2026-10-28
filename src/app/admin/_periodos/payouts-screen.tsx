"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { periodPayoutsPath, ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { DataTable } from "@/ui/data-table";
import { Dialog } from "@/ui/dialog";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { StatusBadge } from "@/ui/status-badge";
import { Textarea } from "@/ui/textarea";
import { TextLink } from "@/ui/text-link";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { payoutsAction, periodCodeAction } from "./actions";
import { UNDERSTOOD, type CodeState } from "./outcomes";
import { payoutFailureText, payoutToneOf } from "./payouts-failures";
import { payoutsButton, TEXT_MAX, type PayoutAsk, type PayoutsState } from "./payouts-outcomes";
import type { PayoutFilter, PayoutsView, PayoutViewRow } from "./payouts-rows";

// PA-81 · Las liquidaciones de un periodo: llevarlas de calculadas a liberadas, retener la que se investiga y
// decidir el bono de fundador (RF-505, RF-506, RF-508, RN-12, RN-17; FL-51). Mínima con T-605 (decisión de
// Sergio del 2026-10-27): sin retenciones, neto ni factura, que llegan con T-409 y T-604.
//
// Todo funciona sin JavaScript, salvo el filtro por estado, que es una ayuda y sin JavaScript no se pinta: se
// ven todas. La tabla y liberar son un solo formulario con un solo estado: cada botón dice su paso con `do`.
// Liberar y soltar una retenida que se libera ahí mismo abren un diálogo irreversible; retener y anular abren
// su motivo dentro de la fila. El primer paso no llama a nadie.

const text = admin.periods.payouts;
const CODE_IDLE: CodeState = { kind: "idle" };
const IDLE: PayoutsState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const CODE_BLOCK_ID = "bloque-liquidaciones-codigo";
const CODE_TITLE_ID = "liquidaciones-codigo-titulo";
const CODE_FIELD_ID = "liquidaciones-codigo";
const BLOCK_ID = "bloque-liquidaciones";
const HEADING_ID = "liquidaciones-titulo";
const UNDERSTOOD_ID = "liquidaciones-entiendo";
const REASON_ID = "liquidaciones-motivo";

/** Los avisos con que vuelve una decisión que salió bien (`notice.ts`). */
export type PayoutsNotice = "payouts_released" | "payouts_updated";
const DONE: Record<PayoutsNotice, string> = { payouts_released: text.done.released, payouts_updated: text.done.updated };

export interface PayoutsScreenProps {
  view: PayoutsView;
  done?: PayoutsNotice | null;
}

/** Lo que se pregunta, si sigue siendo de lo que se ve: con la página leída de nuevo, lo de antes ya no vale. */
function askStillShown(ask: PayoutAsk, view: PayoutsView): boolean {
  switch (ask.what) {
    case "release":
      return view.release.kind === "offered" && view.release.seen === ask.seen;
    case "hold":
      return view.rows.some((row) => row.hold?.confirm === payoutsButton.hold(ask.payout, ask.status));
    case "unhold":
      return view.rows.some((row) => row.unhold?.ask === payoutsButton.askUnhold(ask.payout, ask.seen));
    case "void":
      return view.rows.some((row) => row.founderBonus?.id === ask.bonus);
  }
}

export function PayoutsScreen({ view, done = null }: PayoutsScreenProps) {
  const page = periodPayoutsPath(view.periodId);
  const [code, codeAction, codePending] = useActionState(periodCodeAction.bind(null, { period: view.periodId, page: "payouts" }), CODE_IDLE, `${page}#${CODE_BLOCK_ID}`);
  const [state, send, pending] = useActionState(payoutsAction.bind(null, view.periodId), IDLE, `${page}#${BLOCK_ID}`);
  const doneBox = useRef<HTMLDivElement>(null);
  // El filtro es una ayuda de JavaScript: sin él no se pinta y se ven todas.
  const mounted = useHydrated();
  const [filter, setFilter] = useState<PayoutFilter | "all">("all");

  useEffect(() => {
    if (done !== null && (document.activeElement === null || document.activeElement === document.body)) doneBox.current?.focus();
  }, [done]);

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const failure = pending || state.kind !== "failed" ? null : state.reason === "needs_code" && view.canChange ? null : state;
  const result = failure === null ? null : payoutFailureText(failure.reason, failure.detail);
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const showDone = done !== null && state.kind === "idle" && !pending;
  const asking = state.kind === "asking" && view.canChange && askStillShown(state.ask, view) ? state : null;
  // Confirmar sin la casilla o sin el motivo: el foco va al campo, que tiene el error como descripción.
  const missingAttempt = asking !== null && asking.missing !== null ? asking.attempt : 0;
  useEffect(() => {
    if (missingAttempt > 0) document.getElementById(asking?.missing === "reason" ? REASON_ID : UNDERSTOOD_ID)?.focus();
  }, [missingAttempt, asking?.missing]);

  const shown = filter === "all" ? view.rows : view.rows.filter((row) => row.filter === filter);
  const releaseAsked = asking !== null && asking.ask.what === "release" && view.release.kind === "offered" ? asking : null;
  const unholdAsked = asking !== null && asking.ask.what === "unhold" ? asking.ask : null;
  const unholdRow = unholdAsked === null ? null : (view.rows.find((row) => row.unhold?.ask === payoutsButton.askUnhold(unholdAsked.payout, unholdAsked.seen)) ?? null);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-3">
        <BackLink href={view.panelHref}>{view.name}</BackLink>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-h1">{text.title}</h1>
          <StatusBadge tone={view.tone}>{view.status}</StatusBadge>
        </div>
        {view.releasedLine !== null && <p>{view.releasedLine}</p>}
        {!view.notClosed && <p className="text-text-2">{view.minimumLine}</p>}
      </div>

      {view.notClosed && (
        <InlineAlert tone="neutral">
          {text.notClosed} <TextLink href={view.closeHref}>{text.goToClose}</TextLink>
        </InlineAlert>
      )}

      {!view.notClosed && !view.paid && !view.canChange && (
        <CodeBlock
          blockId={CODE_BLOCK_ID}
          titleId={CODE_TITLE_ID}
          fieldId={CODE_FIELD_ID}
          body={text.codeBody}
          notAvailable={admin.periods.codeNotAvailable}
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
      {view.paid && <InlineAlert tone="success">{text.periodPaid}</InlineAlert>}

      {!view.notClosed && (
        <section ref={block} id={BLOCK_ID} aria-labelledby={HEADING_ID} tabIndex={-1} className="flex flex-col gap-6 outline-none">
          <h2 id={HEADING_ID} className="sr-only">
            {t(text.caption)}
          </h2>
          <BlockResult message={result} tone={failure === null ? "warning" : payoutToneOf(failure.reason)} pending={pending} pendingText={text.releasing} answer={answer} spoken={spoken} />
          {view.estimated && <p className="text-text-2">{text.estimatedNote}</p>}

          {mounted && view.filters.length > 2 && (
            <div role="group" aria-label={text.filterLabel} className="flex flex-wrap gap-2">
              {view.filters.map((each) => (
                <button
                  key={each.key}
                  type="button"
                  aria-pressed={filter === each.key}
                  onClick={() => setFilter(each.key)}
                  className="h-control-sm cursor-pointer rounded-md border border-border-control px-3 text-body-s aria-pressed:border-accent aria-pressed:bg-surface-2"
                >
                  {each.label}
                </button>
              ))}
            </div>
          )}

          <form action={send} noValidate className="flex flex-col gap-6">
            {view.release.kind === "waits" && <p className="text-text-2">{view.release.text}</p>}
            {view.release.kind === "offered" && releaseAsked === null && (
              <div>
                <Button type="submit" variant="danger" name="do" value={view.release.ask}>
                  {text.release}
                </Button>
              </div>
            )}

            <DataTable
              caption={t(text.caption)}
              scroll
              columns={[
                { key: "teacher", header: t(text.columns.teacher) },
                { key: "status", header: text.columns.status },
                { key: "pool", header: text.columns.pool, numeric: true },
                { key: "founder", header: text.columns.founder },
                { key: "bonuses", header: text.columns.bonuses, numeric: true },
                { key: "adjustments", header: text.columns.adjustments, numeric: true },
                { key: "balance", header: text.columns.balance, numeric: true },
                { key: "subtotal", header: text.columns.subtotal, numeric: true },
                ...(view.canChange ? [{ key: "actions", header: text.columns.actions }] : []),
              ]}
              rows={shown.map((row) => ({
                key: row.key,
                cells: {
                  teacher: row.teacher,
                  status: (
                    <span className="flex flex-col gap-1">
                      <StatusBadge tone={row.tone}>{row.status}</StatusBadge>
                      {row.holdReason !== null && <span className="text-body-s text-text-2">{row.holdReason}</span>}
                    </span>
                  ),
                  pool: row.pool,
                  founder: row.founder,
                  bonuses: row.bonuses,
                  adjustments: row.adjustments,
                  balance: row.balance,
                  subtotal: (
                    <span className="flex flex-col gap-1">
                      <span>{row.subtotal}</span>
                      {row.minimum !== null && <span className="text-body-s text-text-2">{row.minimum}</span>}
                    </span>
                  ),
                  actions: <RowActions row={row} asking={asking} pending={pending} />,
                },
              }))}
              totals={{
                teacher: text.total,
                status: "",
                pool: view.totals.pool,
                founder: "",
                bonuses: view.totals.bonuses,
                adjustments: view.totals.adjustments,
                balance: view.totals.balance,
                subtotal: view.totals.subtotal,
                ...(view.canChange ? { actions: "" } : {}),
              }}
              empty={view.rows.length === 0 ? text.empty : text.emptyFiltered}
            />

            {releaseAsked !== null && view.release.kind === "offered" && (
              <Dialog
                title={view.release.title}
                irreversible
                busy={pending}
                extra={
                  <Checkbox
                    key={`liberar-entiendo-${releaseAsked.attempt}`}
                    id={UNDERSTOOD_ID}
                    name="understood"
                    value={UNDERSTOOD}
                    label={text.understood}
                    error={releaseAsked.missing === "understood" ? text.missingUnderstood : undefined}
                  />
                }
                cancel={
                  <Button type="submit" variant="secondary" name="do" value={payoutsButton.cancel()} disabled={pending}>
                    {text.keepReviewing}
                  </Button>
                }
                confirm={
                  <Button type="submit" variant="danger" name="do" value={view.release.confirm} loading={pending} loadingLabel={text.releasing}>
                    {text.confirmRelease}
                  </Button>
                }
              >
                <p>{view.release.body}</p>
                <p>{t(text.releaseDialogUndo)}</p>
              </Dialog>
            )}

            {unholdRow !== null && unholdRow.unhold !== null && asking !== null && (
              <Dialog
                title={unholdRow.unhold.title}
                irreversible={unholdRow.unhold.releases}
                busy={pending}
                extra={
                  <div className="flex flex-col gap-4">
                    <Textarea label={text.unholdNote} name="note" optional maxLength={TEXT_MAX} rows={2} />
                    {unholdRow.unhold.releases && (
                      <Checkbox
                        key={`soltar-entiendo-${asking.attempt}`}
                        id={UNDERSTOOD_ID}
                        name="understood"
                        value={UNDERSTOOD}
                        label={text.understood}
                        error={asking.missing === "understood" ? text.missingUnderstood : undefined}
                      />
                    )}
                  </div>
                }
                cancel={
                  <Button type="submit" variant="secondary" name="do" value={payoutsButton.cancel()} disabled={pending}>
                    {text.keepReviewing}
                  </Button>
                }
                confirm={
                  <Button type="submit" variant={unholdRow.unhold.releases ? "danger" : "primary"} name="do" value={unholdRow.unhold.confirm} loading={pending} loadingLabel={text.unholding}>
                    {text.confirmUnhold}
                  </Button>
                }
              >
                <p>{unholdRow.unhold.body}</p>
              </Dialog>
            )}
          </form>
        </section>
      )}

      <p className="text-body-s">
        <TextLink href={ROUTES.periods}>{admin.periods.backToPeriods}</TextLink>
      </p>
    </main>
  );
}

interface RowActionsProps {
  row: PayoutViewRow;
  asking: Extract<PayoutsState, { kind: "asking" }> | null;
  pending: boolean;
}

/** Los botones de una fila. Retener y anular abren su motivo aquí mismo; soltar abre su diálogo, abajo. */
function RowActions({ row, asking, pending }: RowActionsProps) {
  const ask = asking?.ask;
  const holding = ask?.what === "hold" && row.hold !== null && row.hold.confirm === payoutsButton.hold(ask.payout, ask.status);
  const voiding = ask?.what === "void" && row.founderBonus !== null && row.founderBonus.id === ask.bonus;
  const missingReason = asking?.missing === "reason";

  if (holding && row.hold !== null) {
    return (
      <span className="flex min-w-64 flex-col gap-3">
        <Textarea
          key={`motivo-${asking?.attempt ?? 0}`}
          id={REASON_ID}
          label={text.holdReason}
          name="reason"
          maxLength={TEXT_MAX}
          rows={2}
          error={missingReason ? text.holdReasonMissing : undefined}
        />
        <span className="flex flex-wrap gap-2">
          <Button type="submit" variant="danger" name="do" value={row.hold.confirm} loading={pending} loadingLabel={text.holding}>
            {text.confirmHold}
          </Button>
          <Button type="submit" variant="secondary" name="do" value={payoutsButton.cancel()} disabled={pending}>
            {text.cancel}
          </Button>
        </span>
      </span>
    );
  }
  if (voiding && row.founderBonus !== null) {
    return (
      <span className="flex min-w-64 flex-col gap-3">
        <Textarea
          key={`anular-${asking?.attempt ?? 0}`}
          id={REASON_ID}
          label={text.voidReason}
          name="reason"
          maxLength={TEXT_MAX}
          rows={2}
          error={missingReason ? text.voidReasonMissing : undefined}
        />
        <span className="flex flex-wrap gap-2">
          <Button type="submit" variant="danger" name="do" value={row.founderBonus.void} loading={pending} loadingLabel={text.voiding}>
            {text.confirmVoid}
          </Button>
          <Button type="submit" variant="secondary" name="do" value={payoutsButton.cancel()} disabled={pending}>
            {text.cancel}
          </Button>
        </span>
      </span>
    );
  }
  // Mientras se pregunta algo, las demás filas no pintan botones: así no se pulsa otra cosa por error.
  if (asking !== null) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {row.founderBonus !== null && (
        <>
          <Button type="submit" variant="secondary" name="do" value={row.founderBonus.confirm} disabled={pending}>
            {text.confirmBonus}
          </Button>
          <Button type="submit" variant="secondary" name="do" value={row.founderBonus.askVoid} disabled={pending}>
            {text.voidBonus}
          </Button>
        </>
      )}
      {row.hold !== null && (
        <Button type="submit" variant="secondary" name="do" value={row.hold.ask} disabled={pending}>
          {text.hold}
        </Button>
      )}
      {row.unhold !== null && (
        <Button type="submit" variant="secondary" name="do" value={row.unhold.ask} disabled={pending}>
          {text.unhold}
        </Button>
      )}
    </span>
  );
}
