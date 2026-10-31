"use client";

import { useActionState, useEffect, useRef } from "react";

import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { adminTeacherPath, ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { StatusBadge } from "@/ui/status-badge";
import { Textarea } from "@/ui/textarea";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { teachersAction, teachersCodeAction } from "./actions";
import { LIMITS, type CodeState, type Drafts, type Field, type TeachersState } from "./outcomes";
import { FAILURES, focusIsLost } from "./parts";
import type { TeacherView } from "./rows";

// PA-66 · La ficha de un maestro (`/admin/maestros/<id>`; RF-702; FL-46, FL-64; T-401): el fundador, la suspensión y la
// propuesta de fraude. El retrato llega con T-410. Suspender y confirmar un fraude van en dos pasos: el primero solo
// pregunta, y dice todo lo que va a pasar. Cada botón lleva lo que se vio del maestro. Lo que no se le ofrece a quien mira
// (sobre sí, o porque ya firmó) lo dice la pantalla, y la base lo vuelve a decidir.

const text = admin.teachers;
const detail = text.detail;

const CODE_IDLE: CodeState = { kind: "idle" };
const IDLE: TeachersState = { kind: "idle" };
const CODE_BLOCK_ID = "bloque-maestro-codigo";
const CODE_TITLE_ID = "maestro-codigo-titulo";
const CODE_FIELD_ID = "maestro-codigo";
const BLOCK_ID = "bloque-maestro-ficha";

export type TeacherDone = "teacher_founder_saved" | "teacher_suspended" | "teacher_lifted" | "teacher_fraud_confirmed" | "teacher_fraud_rejected";

const DONE: Record<TeacherDone, string> = {
  teacher_founder_saved: text.done.founderSaved,
  teacher_suspended: t(text.done.suspended),
  teacher_lifted: text.done.lifted,
  teacher_fraud_confirmed: t(text.done.fraudConfirmed),
  teacher_fraud_rejected: text.done.fraudRejected,
};

const PROBLEMS: Partial<Record<Field, string>> = {
  since: detail.sinceProblem,
  reason: detail.reasonProblem,
  notice: t(detail.noticeProblem),
  note: detail.noteProblem,
};

export function TeacherScreen({ view, done = null }: { view: TeacherView; done?: TeacherDone | null }) {
  const page = adminTeacherPath(view.id);
  const [code, codeAction, codePending] = useActionState(teachersCodeAction, CODE_IDLE, `${ROUTES.adminTeachers}#${CODE_BLOCK_ID}`);
  const [state, send, pending] = useActionState(teachersAction, IDLE, `${page}#${BLOCK_ID}`);
  const doneBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done !== null && focusIsLost()) doneBox.current?.focus();
  }, [done]);

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const failure = pending || state.kind !== "failed" ? null : state.reason === "needs_code" && view.canChange ? null : state;
  const result = failure === null ? null : FAILURES[failure.reason];
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const tone = failure !== null && (failure.reason === "unavailable" || failure.reason === "unknown") ? "danger" : "warning";

  const drafts: Drafts = state.kind === "idle" ? {} : state.drafts;
  const step = state.kind === "invalid" || state.kind === "failed" ? state.step : null;
  const problem = (field: Field, ...steps: string[]) =>
    state.kind === "invalid" && steps.includes(state.step) && state.problems.includes(field) ? PROBLEMS[field] : undefined;
  const asking = state.kind === "asking" ? state.ask : null;
  const suspendOpen = asking === "suspend" || step === "suspend";
  const confirmOpen = asking === "confirm" || step === "confirm";

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{view.name}</h1>
        {view.email !== null && <p className="text-text-2">{view.email}</p>}
        <p>
          <StatusBadge tone={view.status.tone}>{view.status.label}</StatusBadge>
        </p>
      </div>

      {!view.canChange && (
        <CodeBlock
          blockId={CODE_BLOCK_ID}
          titleId={CODE_TITLE_ID}
          fieldId={CODE_FIELD_ID}
          body={t(text.codeBody)}
          notAvailable={t(text.codeNotAvailable)}
          state={code}
          action={codeAction}
          pending={codePending}
        />
      )}

      <section ref={block} id={BLOCK_ID} tabIndex={-1} aria-label={detail.blockLabel} className="flex flex-col gap-8 outline-none">
        {!view.canChange && <p className="text-body-s text-text-2">{text.changeLocked}</p>}
        {view.isSelf && <InlineAlert tone="warning">{detail.isSelf}</InlineAlert>}
        {done !== null && state.kind === "idle" && (
          <div ref={doneBox} tabIndex={-1} className="outline-none">
            <InlineAlert tone="success">{DONE[done]}</InlineAlert>
          </div>
        )}
        <BlockResult message={result} tone={tone} pending={pending} pendingText={text.working} answer={answer} spoken={spoken} />

        {view.request !== null && (
          <form action={send} noValidate className="flex flex-col gap-3 rounded-md border border-border p-4">
            <h2 className="text-h3">{detail.fraudTitle}</h2>
            <p className="text-body-s text-text-2">
              {view.request.proposed} {view.request.metric}
            </p>
            <p className="break-words whitespace-pre-line">{view.request.reason}</p>
            {view.request.blocked !== null && <p className="text-text-2">{view.request.blocked}</p>}
            {view.canChange && view.request.confirm !== null && view.request.ask !== null && view.request.reject !== null && (
              <>
                <Textarea
                  key={`fraude-aviso-${attempt}`}
                  id="maestro-fraude-aviso"
                  label={t(detail.noticeLabel)}
                  hint={detail.noticeHint}
                  name="notice"
                  defaultValue={drafts.notice}
                  maxLength={LIMITS.notice}
                  error={problem("notice", "ask_confirm", "confirm")}
                />
                <Textarea
                  key={`fraude-nota-${attempt}`}
                  id="maestro-fraude-nota"
                  label={detail.noteLabel}
                  name="note"
                  optional
                  defaultValue={drafts.note}
                  maxLength={LIMITS.note}
                  error={problem("note", "reject")}
                />
                {confirmOpen ? (
                  <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
                    <p className="font-semibold">{detail.confirmFraudQuestion}</p>
                    <p className="text-text-2">{t(detail.confirmFraudBody)}</p>
                    <div className="flex flex-wrap gap-3">
                      <Button type="submit" name="do" value={view.request.confirm} disabled={pending}>
                        {detail.confirmFraud}
                      </Button>
                      <Button type="submit" name="do" value="cancel" variant="secondary" disabled={pending}>
                        {detail.keepReviewing}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" name="do" value={view.request.ask} disabled={pending}>
                      {detail.askConfirmFraud}
                    </Button>
                    <Button type="submit" name="do" value={view.request.reject} variant="secondary" disabled={pending}>
                      {detail.rejectFraud}
                    </Button>
                  </div>
                )}
              </>
            )}
          </form>
        )}

        {view.founder !== null && (
          <form action={send} noValidate className="flex flex-col gap-3">
            <h2 className="text-h3">{detail.founderTitle}</h2>
            <p className="text-text-2">{view.founder.label ?? detail.notFounder}</p>
            <p className="text-body-s text-text-2">{detail.founderBody}</p>
            {view.canChange && (
              <>
                <TextField
                  key={`fundador-${attempt}`}
                  id="maestro-fundador-desde"
                  label={detail.sinceLabel}
                  name="since"
                  type="date"
                  autoComplete="off"
                  defaultValue={drafts.since ?? view.founder.since ?? undefined}
                  error={problem("since", "founder")}
                />
                <div className="flex flex-wrap gap-3">
                  <Button type="submit" name="do" value={view.founder.save} variant="secondary" disabled={pending}>
                    {detail.saveFounder}
                  </Button>
                  {view.founder.clear !== null && (
                    <Button type="submit" name="do" value={view.founder.clear} variant="secondary" disabled={pending}>
                      {detail.clearFounder}
                    </Button>
                  )}
                </div>
              </>
            )}
          </form>
        )}

        {view.suspension !== null && (
          <div className="flex flex-col gap-2">
            <h2 className="text-h3">{view.suspension.kind}</h2>
            {view.suspension.since !== null && <p className="text-body-s text-text-2">{t(detail.suspendedOn, { date: view.suspension.since })}</p>}
            {view.suspension.reason !== null && <p className="break-words whitespace-pre-line">{t(detail.suspensionReason, { reason: view.suspension.reason })}</p>}
            {view.suspension.notice !== null && <p className="break-words whitespace-pre-line">{t(detail.suspensionNotice, { notice: view.suspension.notice })}</p>}
          </div>
        )}

        {view.canChange && view.lift !== null && (
          <form action={send} noValidate>
            <Button type="submit" name="do" value={view.lift} variant="secondary" disabled={pending}>
              {detail.lift}
            </Button>
          </form>
        )}

        {view.canChange && view.suspend !== null && (
          <form action={send} noValidate className="flex flex-col gap-3">
            <h2 className="text-h3">{detail.suspendTitle}</h2>
            <p className="text-body-s text-text-2">{t(detail.suspendBody)}</p>
            <Textarea
              key={`motivo-${attempt}`}
              id="maestro-suspender-motivo"
              label={detail.reasonLabel}
              hint={t(detail.reasonHint)}
              name="reason"
              defaultValue={drafts.reason}
              maxLength={LIMITS.reason}
              error={problem("reason", "ask_suspend", "suspend")}
            />
            <Textarea
              key={`aviso-${attempt}`}
              id="maestro-suspender-aviso"
              label={t(detail.noticeLabel)}
              hint={detail.noticeHint}
              name="notice"
              defaultValue={drafts.notice}
              maxLength={LIMITS.notice}
              error={problem("notice", "ask_suspend", "suspend")}
            />
            {suspendOpen ? (
              <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
                <p className="font-semibold">{t(detail.confirmSuspendQuestion)}</p>
                <div className="flex flex-wrap gap-3">
                  <Button type="submit" name="do" value={view.suspend.confirm} disabled={pending}>
                    {detail.confirmSuspend}
                  </Button>
                  <Button type="submit" name="do" value="cancel" variant="secondary" disabled={pending}>
                    {detail.keepReviewing}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button type="submit" name="do" value={view.suspend.ask} variant="secondary" disabled={pending}>
                  {detail.askSuspend}
                </Button>
              </div>
            )}
          </form>
        )}
      </section>

      <p className="text-body-s">
        <TextLink href={ROUTES.adminTeachers}>{t(text.backToList)}</TextLink>
      </p>
    </main>
  );
}
