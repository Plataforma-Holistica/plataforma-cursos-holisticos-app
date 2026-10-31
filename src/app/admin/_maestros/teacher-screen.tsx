"use client";

import { useActionState, useEffect, useRef } from "react";

import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { adminTeacherPath, ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { StatusBadge } from "@/ui/status-badge";
import { Textarea } from "@/ui/textarea";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { teachersAction, teachersCodeAction } from "./actions";
import { LIMITS, formOfState, teachersButton, type CodeState, type Drafts, type Field, type TeacherForm, type TeachersState } from "./outcomes";
import { FAILURES, focusIsLost } from "./parts";
import type { TeacherDone, TeacherView } from "./rows";

// PA-66 · La ficha de un maestro (`/admin/maestros/<id>`; RF-702; FL-46, FL-64; T-401): el fundador, la suspensión y la
// propuesta de fraude. El retrato llega con T-410. Suspender y confirmar un fraude van en dos pasos: el primero solo
// pregunta, y dice todo lo que va a pasar. Cada botón lleva lo que se vio del maestro. Lo que no se le ofrece a quien mira
// (sobre sí, o porque ya firmó) lo dice la pantalla, y la base lo vuelve a decidir.
//
// Hay tres formularios y un solo estado: lo escrito y el número de intento solo le tocan al formulario que envió
// (`formOfState`). Sin eso, un «Guardar la fecha» que falla borraría lo que se escribía para suspender, y el aviso escrito
// para una suspensión aparecería en el de un fraude.

const text = admin.teachers;
const detail = text.detail;

const CODE_IDLE: CodeState = { kind: "idle" };
const IDLE: TeachersState = { kind: "idle" };
const CODE_BLOCK_ID = "bloque-maestro-codigo";
const CODE_TITLE_ID = "maestro-codigo-titulo";
const CODE_FIELD_ID = "maestro-codigo";
const BLOCK_ID = "bloque-maestro-ficha";
const SINCE_ID = "maestro-fundador-desde";
const REASON_ID = "maestro-suspender-motivo";
const SUSPEND_NOTICE_ID = "maestro-suspender-aviso";
const FRAUD_NOTICE_ID = "maestro-fraude-aviso";
const FRAUD_NOTE_ID = "maestro-fraude-nota";

const DONE: Record<TeacherDone, string> = {
  teacher_founder_saved: text.done.founderSaved,
  teacher_suspended: t(text.done.suspended),
  teacher_lifted: text.done.lifted,
  teacher_fraud_confirmed: t(text.done.fraudConfirmed),
  teacher_fraud_rejected: text.done.fraudRejected,
};

const PROBLEMS: Record<Exclude<Field, "name" | "email">, string> = {
  since: detail.sinceProblem,
  reason: detail.reasonProblem,
  notice: t(detail.noticeProblem),
  note: detail.noteProblem,
};

export function TeacherScreen({ view, done = null }: { view: TeacherView; done?: TeacherDone | null }) {
  const page = adminTeacherPath(view.id);
  const [code, codeAction, codePending] = useActionState(teachersCodeAction.bind(null, view.id), CODE_IDLE, `${page}#${CODE_BLOCK_ID}`);
  const [state, send, pending] = useActionState(teachersAction, IDLE, `${page}#${BLOCK_ID}`);
  const doneBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done !== null && focusIsLost()) doneBox.current?.focus();
  }, [done]);

  // «Seguir revisando» no contesta nada: cuenta como sin respuesta, y el foco vuelve al bloque.
  const answered = state.kind === "idle" || state.kind === "editing" ? 0 : state.attempt;
  const failure = pending || state.kind !== "failed" ? null : state.reason === "needs_code" && view.canChange ? null : state;
  const result = failure === null ? null : FAILURES[failure.reason];
  const { block, answer, spoken } = useAnswerFocus(pending, answered, result);
  const tone = failure !== null && (failure.reason === "unavailable" || failure.reason === "unknown") ? "danger" : "warning";

  const owner = formOfState(state);
  /** Lo escrito, y el intento que arma de nuevo los campos, solo para el formulario que envió. */
  const draftsOf = (form: TeacherForm): Drafts => (owner === form && state.kind !== "idle" ? state.drafts : {});
  const roundOf = (form: TeacherForm): number => (owner === form && state.kind !== "idle" ? state.attempt : 0);
  const problem = (field: keyof typeof PROBLEMS, form: TeacherForm) =>
    owner === form && state.kind === "invalid" && state.problems.includes(field) ? PROBLEMS[field] : undefined;
  const errorsOf = (form: TeacherForm, fields: [keyof typeof PROBLEMS, string][]): FormError[] =>
    fields.flatMap(([field, fieldId]) => {
      const message = problem(field, form);
      return message === undefined ? [] : [{ fieldId, message }];
    });

  // Una respuesta que falló cierra la pregunta: lo que dice va arriba, y lo escrito se queda en sus campos.
  const asked = (form: TeacherForm, ask: "suspend" | "confirm", step: string) =>
    (owner === form && state.kind === "asking" && state.ask === ask) || (owner === form && state.kind === "invalid" && state.step === step);
  const suspendOpen = asked("suspend", "suspend", "suspend");
  const confirmOpen = asked("fraud", "confirm", "confirm");
  // El aviso del resultado toma el foco; una pregunta recién abierta, también. Con un error de campo lo toma el resumen.
  const questionRef = state.kind === "asking" ? answer : undefined;

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
                <FormErrorSummary errors={errorsOf("fraud", [["notice", FRAUD_NOTICE_ID], ["note", FRAUD_NOTE_ID]])} attempt={roundOf("fraud")} />
                <Textarea
                  key={`fraude-aviso-${roundOf("fraud")}`}
                  id={FRAUD_NOTICE_ID}
                  label={t(detail.noticeLabel)}
                  hint={detail.noticeHint}
                  name="notice"
                  defaultValue={draftsOf("fraud").notice}
                  maxLength={LIMITS.notice}
                  readOnly={pending}
                  error={problem("notice", "fraud")}
                />
                <Textarea
                  key={`fraude-nota-${roundOf("fraud")}`}
                  id={FRAUD_NOTE_ID}
                  label={detail.noteLabel}
                  name="note"
                  optional
                  defaultValue={draftsOf("fraud").note}
                  maxLength={LIMITS.note}
                  readOnly={pending}
                  error={problem("note", "fraud")}
                />
                {confirmOpen ? (
                  <div ref={questionRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
                    <p className="font-semibold">{detail.confirmFraudQuestion}</p>
                    <p className="text-text-2">{t(detail.confirmFraudBody)}</p>
                    <div className="flex flex-wrap gap-3">
                      <Button type="submit" name="do" value={view.request.confirm} disabled={pending}>
                        {detail.confirmFraud}
                      </Button>
                      <Button type="submit" name="do" value={teachersButton.cancel("fraud", view.id)} variant="secondary" disabled={pending}>
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
                <FormErrorSummary errors={errorsOf("founder", [["since", SINCE_ID]])} attempt={roundOf("founder")} />
                <TextField
                  key={`fundador-${roundOf("founder")}-${view.founder.since ?? ""}`}
                  id={SINCE_ID}
                  label={detail.sinceLabel}
                  name="since"
                  type="date"
                  autoComplete="off"
                  defaultValue={draftsOf("founder").since ?? view.founder.since ?? undefined}
                  readOnly={pending}
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
            <FormErrorSummary errors={errorsOf("suspend", [["reason", REASON_ID], ["notice", SUSPEND_NOTICE_ID]])} attempt={roundOf("suspend")} />
            <Textarea
              key={`motivo-${roundOf("suspend")}`}
              id={REASON_ID}
              label={detail.reasonLabel}
              hint={t(detail.reasonHint)}
              name="reason"
              defaultValue={draftsOf("suspend").reason}
              maxLength={LIMITS.reason}
              readOnly={pending}
              error={problem("reason", "suspend")}
            />
            <Textarea
              key={`aviso-${roundOf("suspend")}`}
              id={SUSPEND_NOTICE_ID}
              label={t(detail.noticeLabel)}
              hint={detail.noticeHint}
              name="notice"
              defaultValue={draftsOf("suspend").notice}
              maxLength={LIMITS.notice}
              readOnly={pending}
              error={problem("notice", "suspend")}
            />
            {suspendOpen ? (
              <div ref={questionRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
                <p className="font-semibold">{t(detail.confirmSuspendQuestion)}</p>
                <div className="flex flex-wrap gap-3">
                  <Button type="submit" name="do" value={view.suspend.confirm} disabled={pending}>
                    {detail.confirmSuspend}
                  </Button>
                  <Button type="submit" name="do" value={teachersButton.cancel("suspend", view.id)} variant="secondary" disabled={pending}>
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
