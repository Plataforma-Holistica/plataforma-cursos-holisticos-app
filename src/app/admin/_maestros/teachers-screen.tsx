"use client";

import { useActionState, useEffect, useRef } from "react";

import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { DataTable } from "@/ui/data-table";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { StatusBadge } from "@/ui/status-badge";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { AdminMain } from "../_lib/shell";
import { teachersAction, teachersCodeAction } from "./actions";
import type { CodeState, TeachersState } from "./outcomes";
import { FAILURES, focusIsLost } from "./parts";
import type { RosterRowView, RosterView } from "./rows";

// PA-65 · Los maestros (`/admin/maestros`; RF-104; FL-46; T-401). Por bloques: «Tu código», cuando hace falta; las
// suspensiones por confirmar; invitar; y la lista. Invitar no manda ningún correo: la pantalla dice qué avisarle a la
// persona, como la del equipo (decisión de Sergio del 2026-10-29). Los cambios se ofrecen solo si la página leyó un código
// reciente. Lo escrito viaja en el estado: React devuelve el formulario a sus valores por omisión.

const text = admin.teachers;

const CODE_IDLE: CodeState = { kind: "idle" };
const IDLE: TeachersState = { kind: "idle" };
const CODE_BLOCK_ID = "bloque-maestros-codigo";
const LIST_BLOCK_ID = "bloque-maestros-lista";
const CODE_TITLE_ID = "maestros-codigo-titulo";
const CODE_FIELD_ID = "maestros-codigo";
const INVITE_NAME_ID = "maestros-invitar-nombre";
const INVITE_EMAIL_ID = "maestros-invitar-correo";

export type TeachersDone = "teacher_invited" | "teacher_reinvited" | "teacher_invitation_revoked";

const DONE: Record<TeachersDone, string> = {
  teacher_invited: text.done.invited,
  teacher_reinvited: text.done.reinvited,
  teacher_invitation_revoked: text.done.revoked,
};

export function TeachersScreen({ view, done = null }: { view: RosterView; done?: TeachersDone | null }) {
  const [code, codeAction, codePending] = useActionState(teachersCodeAction, CODE_IDLE, `${ROUTES.adminTeachers}#${CODE_BLOCK_ID}`);
  const [state, send, pending] = useActionState(teachersAction, IDLE, `${ROUTES.adminTeachers}#${LIST_BLOCK_ID}`);
  const doneBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done !== null && focusIsLost()) doneBox.current?.focus();
  }, [done]);

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const failure =
    pending || state.kind !== "failed"
      ? null
      : // Si la página ya leyó un código reciente (se dio después), pedirlo ya no es cierto.
        state.reason === "needs_code" && view.canChange
        ? null
        : state;
  const result = failure === null ? null : FAILURES[failure.reason];
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const tone = failure !== null && (failure.reason === "unavailable" || failure.reason === "unknown") ? "danger" : "warning";

  const invalid = state.kind === "invalid" && state.step === "invite" ? state : null;
  // Lo escrito y el intento solo son de invitar si fue invitar lo que se envió: una fila que falla no borra lo que se escribía.
  const inviting = (state.kind === "invalid" || state.kind === "failed") && state.step === "invite" ? state : null;
  const drafts = inviting?.drafts ?? {};
  const round = inviting?.attempt ?? 0;
  const nameError = invalid?.problems.includes("name") === true ? text.invite.nameProblem : undefined;
  const emailError = invalid?.problems.includes("email") === true ? text.invite.emailProblem : undefined;
  const errors: FormError[] = [
    ...(nameError === undefined ? [] : [{ fieldId: INVITE_NAME_ID, message: nameError }]),
    ...(emailError === undefined ? [] : [{ fieldId: INVITE_EMAIL_ID, message: emailError }]),
  ];

  return (
    <AdminMain area="content" title={t(text.title)} lead={<p>{text.intro}</p>}>
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

      {view.requests.length > 0 && (
        <section aria-labelledby="maestros-propuestas" className="flex max-w-reading flex-col gap-4">
          <h2 id="maestros-propuestas" className="text-h3">
            {text.requests.title}
          </h2>
          <p className="text-text-2">{text.requests.body}</p>
          <ul className="surface-raised divide-y divide-border">
            {view.requests.map((request) => (
              <li key={request.id} className="flex flex-col gap-1 p-4 sm:px-5">
                <p className="font-semibold">{request.title}</p>
                <p className="text-body-s text-text-2">{request.proposed}</p>
                <p className="break-words whitespace-pre-line">{request.reason}</p>
                <p>
                  <TextLink href={request.teacherHref}>{text.requests.open}</TextLink>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section ref={block} id={LIST_BLOCK_ID} tabIndex={-1} aria-labelledby="maestros-lista" className="flex flex-col gap-6 outline-none">
        {/* El título, lo que contestó el último envío y la tabla van juntos: entre «Todos» y su tabla no queda hueco
            (T-616, solicitud 6). Invitar va después de la lista, angosto: lo de todos los días es buscar a alguien. */}
        <div className="flex flex-col gap-3">
          <h2 id="maestros-lista" className="text-h3">
            {text.list.title}
          </h2>
          {!view.canChange && <p className="text-body-s text-text-2">{text.changeLocked}</p>}
          {done !== null && state.kind === "idle" && (
            <div ref={doneBox} tabIndex={-1} className="outline-none">
              <InlineAlert tone="success">{DONE[done]}</InlineAlert>
            </div>
          )}
          <BlockResult message={result} tone={tone} pending={pending} pendingText={text.working} answer={answer} spoken={spoken} />
          <form action={send} noValidate>
            <DataTable
              caption={t(text.list.caption)}
              captionHidden
              columns={[
                { key: "name", header: text.list.name },
                { key: "email", header: text.list.email },
                { key: "status", header: text.list.status },
                { key: "founder", header: text.list.founder },
                { key: "taxData", header: text.list.taxData },
                { key: "invitation", header: text.list.invitation },
              ]}
              rows={view.rows.map((row) => ({
                key: row.id,
                cells: {
                  name: (
                    <>
                      <TextLink href={row.href}>{row.name}</TextLink>
                      {row.isSelf && <span className="block text-body-s text-text-2">{text.list.self}</span>}
                    </>
                  ),
                  email: row.email ?? text.list.noEmail,
                  status: <StatusBadge tone={row.status.tone}>{row.status.label}</StatusBadge>,
                  founder: row.founder ?? text.list.notFounder,
                  taxData: row.taxData,
                  invitation: <InvitationCell row={row} canChange={view.canChange} pending={pending} />,
                },
              }))}
              empty={t(text.list.empty)}
              scroll
            />
          </form>
        </div>

        {view.canChange && (
          <form action={send} noValidate className="flex max-w-reading flex-col gap-4 surface-raised p-4 sm:p-5">
            <h3 className="text-body-l font-semibold">{t(text.invite.title)}</h3>
            <p className="text-body-s text-text-2">{text.invite.body}</p>
            <FormErrorSummary errors={errors} attempt={round} />
            <TextField
              key={`nombre-${round}`}
              id={INVITE_NAME_ID}
              label={text.invite.name}
              name="name"
              autoComplete="off"
              defaultValue={drafts.name}
              readOnly={pending}
              error={nameError}
            />
            <TextField
              key={`correo-${round}`}
              id={INVITE_EMAIL_ID}
              label={text.invite.email}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="off"
              defaultValue={drafts.email}
              readOnly={pending}
              hint={text.invite.emailHint}
              error={emailError}
            />
            <div>
              <Button type="submit" name="do" value="invite" disabled={pending}>
                {text.invite.submit}
              </Button>
            </div>
          </form>
        )}
      </section>

      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </AdminMain>
  );
}

function InvitationCell({ row, canChange, pending }: { row: RosterRowView; canChange: boolean; pending: boolean }) {
  return (
    <div className="flex flex-col items-start gap-2">
      {row.invitation !== null && <span>{row.invitation}</span>}
      {canChange && row.reinvite !== null && (
        <Button type="submit" name="do" value={row.reinvite} variant="secondary" size="md" disabled={pending}>
          {text.list.reinvite}
        </Button>
      )}
      {canChange && row.revoke !== null && (
        <Button type="submit" name="do" value={row.revoke} variant="secondary" size="md" disabled={pending}>
          {text.list.revoke}
        </Button>
      )}
    </div>
  );
}
