"use client";

import { type RefObject, useActionState, useEffect, useRef, useState } from "react";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { InlineAlert } from "@/ui/inline-alert";
import { Select } from "@/ui/select";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { Textarea } from "@/ui/textarea";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { alertsAction, alertsCodeAction } from "./actions";
import type { AlertsFailure, AlertsState, CodeState, ConfirmProblem, Confirming, Drafts } from "./outcomes";
import type { AccountRow, AlertCard, AlertsView, ExclusionRow } from "./rows";

// PA-68 mínima · Las alertas de anomalía, en una sola pantalla (decisiones de Sergio del
// 2026-10-21 y 2026-10-22): la lista, cada alerta con sus cifras, revisarla con una nota, decidir
// fraude con evidencia, excluir del reparto una cuenta de la alerta y revertir una exclusión. El
// aviso al maestro, proponer la suspensión y el ajuste de un periodo cerrado llegan con T-408,
// T-401 y T-603.
//
// Todo funciona sin JavaScript. Las decisiones son un solo estado para toda la lista: cada bloque
// es su propio formulario, ligado a la misma acción, y el botón dice qué y de qué alerta. Decidir
// fraude, excluir y revertir se confirman en dos pasos, dentro de su lugar. Lo que sale bien
// redirige aquí con su aviso; lo demás se dice arriba de la lista.

const text = admin.alerts;
const CODE_IDLE: CodeState = { kind: "idle" };
const LIST_IDLE: AlertsState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const CODE_BLOCK_ID = "bloque-alertas-codigo";
const CODE_TITLE_ID = "alertas-codigo-titulo";
const CODE_FIELD_ID = "alertas-codigo";
const LIST_BLOCK_ID = "bloque-alertas-lista";
const LIST_HEADING_ID = "alertas-lista-titulo";
const CODE_PERMALINK = `${ROUTES.alerts}#${CODE_BLOCK_ID}`;
const LIST_PERMALINK = `${ROUTES.alerts}#${LIST_BLOCK_ID}`;

/** Los avisos con que vuelve una decisión que salió bien (`notice.ts`). */
export type DoneNotice = "alert_reviewed" | "fraud_decided" | "account_excluded" | "exclusion_revoked" | "fraud_proposed" | "fraud_withdrawn";

const DONE: Record<DoneNotice, string> = {
  alert_reviewed: text.done.alertReviewed,
  fraud_decided: text.done.fraudDecided,
  account_excluded: text.done.accountExcluded,
  exclusion_revoked: text.done.exclusionRevoked,
  fraud_proposed: t(text.done.fraudProposed),
  fraud_withdrawn: text.done.fraudWithdrawn,
};

const FAILURES: Record<AlertsFailure, string> = {
  needs_code: text.needsCode,
  missing_note: text.missingNote,
  missing_evidence: text.missingEvidence,
  missing_reason: text.missingReason,
  already_reviewed: text.alreadyReviewed,
  already_fraud: text.alreadyFraud,
  already_excluded: text.alreadyExcluded,
  already_revoked: text.alreadyRevoked,
  closed: text.closedNow,
  needs_fraud_decision: text.needsFraudDecision,
  already_pending: text.alreadyPending,
  already_suspended: text.alreadySuspended,
  alert_used: text.alertUsed,
  not_active: t(text.notActive),
  not_yours: text.notYours,
  self: t(text.self),
  proposer: text.proposer,
  conflict: t(text.conflict),
  not_found: text.notFound,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

const PROBLEMS: Record<ConfirmProblem, string> = {
  missing_evidence: text.missingEvidence,
  missing_reason: text.missingReason,
};

export interface AlertsScreenProps {
  /** Las alertas, ya puestas en palabras por la página. */
  view: AlertsView;
  /** La página llegó con el aviso de una decisión que salió bien. */
  done?: DoneNotice | null;
}

export function AlertsScreen({ view, done = null }: AlertsScreenProps) {
  const [code, codeAction, codePending] = useActionState(alertsCodeAction, CODE_IDLE, CODE_PERMALINK);
  const [list, sendList, listPending] = useActionState(alertsAction, LIST_IDLE, LIST_PERMALINK);
  const doneBox = useRef<HTMLDivElement>(null);

  // Llegó con el aviso de una decisión: si el foco quedó sin dueño (el botón pulsado se fue con
  // la respuesta), lo toma el aviso.
  useEffect(() => {
    if (done !== null && focusIsLost()) doneBox.current?.focus();
  }, [done]);

  const attempt = list.kind === "idle" ? 0 : list.attempt;
  const failure =
    listPending || list.kind !== "failed"
      ? null
      : // Si la página ya leyó un código reciente (se dio después), pedirlo ya no es cierto.
        list.reason === "needs_code" && view.canChange
        ? null
        : list;
  const result = failure === null ? null : withWritten(FAILURES[failure.reason], failure.drafts);
  const tone = failure !== null && (failure.reason === "unavailable" || failure.reason === "unknown") ? "danger" : "warning";
  const { block, answer, spoken } = useAnswerFocus(listPending, attempt, result);

  const confirming = list.kind === "confirming" ? list : null;
  // La nota de una alerta vuelve a su campo cuando falló revisarla, y se queda ahí con lo que
  // conteste después otro bloque: se anota la última vez que falló revisar, y solo eso rearma el
  // campo. Se ajusta al pintar, sin efecto, para que el campo no se arme dos veces.
  const [noteBack, setNoteBack] = useState<NoteBack | null>(null);
  if (list.kind === "failed" && list.step === "review" && list.alert !== null && noteBack?.attempt !== list.attempt) {
    setNoteBack({ alert: list.alert, note: list.drafts.note, attempt: list.attempt });
  }
  // El aviso de lo que salió bien deja de decirse en cuanto hay otra respuesta, o una en camino.
  const showDone = done !== null && list.kind === "idle" && !listPending;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
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

      <section ref={block} id={LIST_BLOCK_ID} aria-labelledby={LIST_HEADING_ID} tabIndex={-1} className="flex flex-col gap-6 outline-none">
        <h2 id={LIST_HEADING_ID} className="text-h2">
          {text.listTitle}
        </h2>
        {!view.canChange && <p className="text-body-s text-text-2">{text.changeLocked}</p>}
        {showDone && (
          <div ref={doneBox} tabIndex={-1} className="outline-none">
            <InlineAlert tone="success">{done === null ? null : DONE[done]}</InlineAlert>
          </div>
        )}
        <BlockResult message={result} tone={tone} pending={listPending} pendingText={text.working} answer={answer} spoken={spoken} />
        {view.alerts.length === 0 ? (
          <p className="text-text-2">{text.empty}</p>
        ) : (
          <ol className="flex flex-col gap-6">
            {view.alerts.map((alert) => (
              <Alert
                key={alert.id}
                alert={alert}
                canChange={view.canChange}
                confirming={confirming !== null && confirming.confirming.alert === alert.id ? confirming : null}
                note={noteBack !== null && noteBack.alert === alert.id ? noteBack : null}
                limits={view.limits}
                answer={answer}
                action={sendList}
                pending={listPending}
              />
            ))}
          </ol>
        )}
        {view.more !== null && <p className="text-body-s text-text-2">{view.more}</p>}
      </section>

      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}

/** El mensaje, y lo que se había escrito en la confirmación que ya se cerró: así no se pierde. */
function withWritten(message: string, drafts: Drafts): string {
  const lost = [drafts.evidence, drafts.reason].find((value) => value !== undefined && value.trim() !== "");
  return lost === undefined ? message : `${message} ${t(text.written, { text: lost.trim() })}`;
}

/** El foco no tiene dueño: quedó en el documento. */
function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** Lo que se había escrito en la nota de una alerta cuando falló revisarla. */
interface NoteBack {
  alert: string;
  note: string | undefined;
  attempt: number;
}

/** Lo que se está preguntando en esta alerta, con lo escrito y lo que falta. */
interface Asked {
  confirming: Confirming;
  drafts: Drafts;
  problem: ConfirmProblem | null;
  attempt: number;
}

interface AlertProps {
  alert: AlertCard;
  canChange: boolean;
  confirming: Asked | null;
  /** Lo que se había escrito en la nota, la última vez que falló revisar esta alerta. */
  note: NoteBack | null;
  limits: AlertsView["limits"];
  /** Dónde va el foco cuando llega la pregunta: el botón pulsado desaparece con ella. */
  answer: RefObject<HTMLDivElement | null>;
  action: (form: FormData) => void;
  pending: boolean;
}

function Alert({ alert, canChange, confirming, note, limits, answer, action, pending }: AlertProps) {
  const headingId = `alertas-alerta-${alert.id}`;
  const asking = (step: Confirming["step"]) => (confirming !== null && confirming.confirming.step === step ? confirming : null);
  const askingFraud = asking("fraud");
  const askingProposal = asking("propose");
  return (
    <li>
      <article aria-labelledby={headingId} className="flex flex-col gap-5 rounded-md border border-border p-4">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-h3 break-words">
            {alert.title}
          </h3>
          <p className="text-body-s font-semibold">{alert.status}</p>
          <p className="text-body-s text-text-2">{alert.period}</p>
        </div>

        <div className="flex flex-col gap-1">
          <p>{alert.trigger}</p>
          {alert.facts.map((fact) => (
            <p key={fact} className="text-text-2 break-words">
              {fact}
            </p>
          ))}
          <p className="text-body-s text-text-2">{alert.detected}</p>
        </div>

        {(alert.reviewed !== null || alert.note !== null || alert.fraud !== null) && (
          <div className="flex flex-col gap-1">
            {alert.reviewed !== null && <p className="text-body-s">{alert.reviewed}</p>}
            {alert.note !== null && <p className="text-text-2 break-words whitespace-pre-line">{alert.note}</p>}
            {alert.fraud !== null && <p className="font-semibold break-words whitespace-pre-line">{alert.fraud}</p>}
          </div>
        )}

        {canChange && alert.open && (
          <form action={action} noValidate className="flex flex-col gap-3">
            <h4 className="text-body-l font-semibold">{text.reviewTitle}</h4>
            {/* Se arma de nuevo solo cuando su envío falló: así vuelve lo que se había escrito. */}
            <Textarea
              key={note === null ? "nota" : `nota-${note.attempt}`}
              id={`alertas-nota-${alert.id}`}
              label={text.noteLabel}
              name="note"
              hint={text.noteHint}
              defaultValue={note?.note}
              maxLength={limits.note}
            />
            <div>
              <Button type="submit" name="do" value={alert.buttons.review} size="md" disabled={pending}>
                {text.markReviewed}
              </Button>
            </div>
          </form>
        )}

        {canChange && alert.canDecideFraud && (
          <form action={action} noValidate className="flex flex-col gap-3">
            <h4 className="text-body-l font-semibold">{text.fraudTitle}</h4>
            <p className="text-text-2">{text.fraudBody}</p>
            {askingFraud !== null ? (
              <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
                <p className="font-semibold">{text.confirmFraudTitle}</p>
                <p className="text-text-2">{text.confirmFraudBody}</p>
                <Textarea
                  key={`evidencia-${askingFraud.attempt}`}
                  id={`alertas-evidencia-${alert.id}`}
                  label={text.evidenceLabel}
                  name="evidence"
                  defaultValue={askingFraud.drafts.evidence}
                  maxLength={limits.note}
                  error={askingFraud.problem === null ? undefined : PROBLEMS[askingFraud.problem]}
                />
                <Confirm value={alert.buttons.fraud} label={text.confirmFraud} pending={pending} />
              </div>
            ) : (
              <div>
                <Button type="submit" name="do" value={alert.buttons.askFraud} variant="secondary" size="md" disabled={pending}>
                  {text.decideFraud}
                </Button>
              </div>
            )}
          </form>
        )}
        {alert.proposal !== null && (
          <form action={action} noValidate className="flex flex-col gap-3">
            <h4 className="text-body-l font-semibold">{t(text.proposalTitle)}</h4>
            <p className="text-text-2">{alert.proposal.text}</p>
            {canChange && alert.proposal.withdraw !== null && (
              <div>
                <Button type="submit" name="do" value={alert.proposal.withdraw} variant="secondary" size="md" disabled={pending}>
                  {text.withdrawProposal}
                </Button>
              </div>
            )}
          </form>
        )}
        {canChange && alert.canPropose && (
          <form action={action} noValidate className="flex flex-col gap-3">
            <h4 className="text-body-l font-semibold">{t(text.proposalTitle)}</h4>
            <p className="text-text-2">{text.proposalBody}</p>
            {askingProposal !== null ? (
              <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
                <p className="font-semibold">{t(text.confirmProposalTitle)}</p>
                <Textarea
                  key={`propuesta-${askingProposal.attempt}`}
                  id={`alertas-propuesta-${alert.id}`}
                  label={text.proposalReasonLabel}
                  name="reason"
                  defaultValue={askingProposal.drafts.reason}
                  maxLength={limits.note}
                  error={askingProposal.problem === null ? undefined : PROBLEMS[askingProposal.problem]}
                />
                <Confirm value={alert.buttons.propose} label={text.confirmProposal} pending={pending} />
              </div>
            ) : (
              <div>
                <Button type="submit" name="do" value={alert.buttons.askProposal} variant="secondary" size="md" disabled={pending}>
                  {text.askProposal}
                </Button>
              </div>
            )}
          </form>
        )}
        {canChange && alert.fraudWaits && (
          <div className="flex flex-col gap-1">
            <h4 className="text-body-l font-semibold">{text.fraudTitle}</h4>
            <p className="text-text-2">{text.fraudAfterReview}</p>
          </div>
        )}

        {alert.accounts.length > 0 && (
          <section className="flex flex-col gap-3">
            <h4 className="text-body-l font-semibold">{alert.accountsTitle}</h4>
            {alert.closed !== null && <p className="text-body-s text-text-2">{alert.closed}</p>}
            <ul className="flex flex-col gap-4">
              {alert.accounts.map((row) => (
                <Account
                  key={row.account}
                  row={row}
                  alertId={alert.id}
                  limit={limits.reason}
                  canChange={canChange}
                  confirming={matches(confirming, row.account) ? confirming : null}
                  answer={answer}
                  action={action}
                  pending={pending}
                />
              ))}
            </ul>
            {alert.moreAccounts !== null && <p className="text-body-s text-text-2">{alert.moreAccounts}</p>}
          </section>
        )}

        {alert.exclusions.length > 0 && (
          <section className="flex flex-col gap-3">
            <h4 className="text-body-l font-semibold">{text.exclusionsTitle}</h4>
            <ul className="flex flex-col gap-3">
              {alert.exclusions.map((row) => (
                <Exclusion
                  key={row.id}
                  row={row}
                  alertId={alert.id}
                  limit={limits.reason}
                  canChange={canChange}
                  confirming={matches(confirming, row.id) ? confirming : null}
                  answer={answer}
                  action={action}
                  pending={pending}
                />
              ))}
            </ul>
          </section>
        )}
      </article>
    </li>
  );
}

/** La pregunta es de esta fila: de esta cuenta, o de esta exclusión. */
function matches(asked: Asked | null, target: string): boolean {
  if (asked === null) return false;
  const { confirming } = asked;
  return (confirming.step === "exclude" && confirming.account === target) || (confirming.step === "revoke" && confirming.exclusion === target);
}

/** «Sí, …» y «Cancelar». Mientras el envío va en camino, el primero dice que carga y el segundo no se pulsa. */
function Confirm({ value, label, pending }: { value: string; label: string; pending: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" name="do" value={value} size="md" loading={pending} loadingLabel={text.working}>
        {label}
      </Button>
      <Button type="submit" name="do" value="cancel" variant="secondary" size="md" disabled={pending}>
        {text.cancel}
      </Button>
    </div>
  );
}

interface AccountProps {
  row: AccountRow;
  alertId: string;
  limit: number;
  canChange: boolean;
  confirming: Asked | null;
  answer: RefObject<HTMLDivElement | null>;
  action: (form: FormData) => void;
  pending: boolean;
}

function Account({ row, alertId, limit, canChange, confirming, answer, action, pending }: AccountProps) {
  const fieldId = `alertas-${alertId}-${row.account}`;
  return (
    <li className="flex flex-col gap-2">
      <p className="font-semibold break-words">
        {row.title}
        {row.excluded && (
          <>
            {SPACE}
            <span className="text-body-s font-regular text-text-2">{text.excluded}</span>
          </>
        )}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-body-s">
        {row.facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-text-2">{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {canChange && row.canExclude && (
        <form action={action} noValidate className="flex flex-col gap-3">
          {confirming !== null ? (
            <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
              <p className="font-semibold break-words">{row.confirmTitle}</p>
              <p className="text-text-2">{row.confirmBody}</p>
              <Select
                key={`motivo-${confirming.attempt}`}
                id={`${fieldId}-motivo`}
                label={text.reasonCodeLabel}
                name="reason_code"
                prompt={text.reasonPrompt}
                options={row.reasons}
                defaultValue={confirming.drafts.reasonCode}
                error={confirming.problem === null ? undefined : PROBLEMS[confirming.problem]}
              />
              <Textarea
                key={`texto-${confirming.attempt}`}
                id={`${fieldId}-texto`}
                label={text.reasonLabel}
                name="reason"
                defaultValue={confirming.drafts.reason}
                maxLength={limit}
              />
              <Confirm value={row.buttons.confirm} label={text.confirmExclude} pending={pending} />
            </div>
          ) : (
            <div>
              <Button type="submit" name="do" value={row.buttons.ask} variant="secondary" size="md" disabled={pending}>
                {text.exclude}
                {SPACE}
                <span className="sr-only">{row.title}</span>
              </Button>
            </div>
          )}
        </form>
      )}
    </li>
  );
}

interface ExclusionProps {
  row: ExclusionRow;
  alertId: string;
  limit: number;
  canChange: boolean;
  confirming: Asked | null;
  answer: RefObject<HTMLDivElement | null>;
  action: (form: FormData) => void;
  pending: boolean;
}

function Exclusion({ row, alertId, limit, canChange, confirming, answer, action, pending }: ExclusionProps) {
  return (
    <li className="flex flex-col gap-2">
      <p className="text-body-s break-words whitespace-pre-line">{row.summary}</p>
      {row.revoked !== null && <p className="text-body-s text-text-2 break-words whitespace-pre-line">{row.revoked}</p>}
      {canChange && row.canRevoke && (
        <form action={action} noValidate className="flex flex-col gap-3">
          {confirming !== null ? (
            <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
              <p className="font-semibold">{text.confirmRevokeTitle}</p>
              <p className="text-text-2">{text.confirmRevokeBody}</p>
              <Textarea
                key={`revertir-${confirming.attempt}`}
                id={`alertas-${alertId}-${row.id}-motivo`}
                label={text.revokeReasonLabel}
                name="reason"
                defaultValue={confirming.drafts.reason}
                maxLength={limit}
                error={confirming.problem === null ? undefined : PROBLEMS[confirming.problem]}
              />
              <Confirm value={row.buttons.confirm} label={text.confirmRevoke} pending={pending} />
            </div>
          ) : (
            <div>
              <Button type="submit" name="do" value={row.buttons.ask} variant="secondary" size="md" disabled={pending}>
                {text.revoke}
                {SPACE}
                <span className="sr-only">{row.summary}</span>
              </Button>
            </div>
          )}
        </form>
      )}
    </li>
  );
}
