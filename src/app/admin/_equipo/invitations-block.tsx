"use client";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";

import type { InvitationsFailure, InvitationsState } from "./outcomes";
import { BlockResult, ConfirmPanel, RowAction, useAnswerFocus } from "./parts";
import type { InvitationRow } from "./rows";

// PA-86 · El bloque «Invitaciones pendientes». Las vivas, caducadas o no: una caducada sigue
// ahí hasta que alguien invita de nuevo o la revoca. Revocar se confirma en dos pasos dentro
// de la fila. Un solo formulario, y cada botón dice lo suyo con su valor.

const text = admin.team;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
export const INVITATIONS_BLOCK_ID = "bloque-equipo-invitaciones";
const TITLE_ID = "equipo-invitaciones-titulo";

const DONE = { revoked: text.invitationRevoked, reinvited: text.reinvited } as const;
const FAILURES: Record<InvitationsFailure, string> = {
  gone: text.invitationGone,
  already_invited: text.alreadyInvited,
  already_member: text.alreadyMember,
  ineligible: text.inviteIneligible,
  not_configured: text.notConfigured,
  invalid: text.invalid,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

/** Lo que contestó el último envío, en palabras. Nulo si no hay nada que decir. */
function resultOf(state: InvitationsState): string | null {
  if (state.kind === "done") return DONE[state.what];
  return state.kind === "failed" ? FAILURES[state.reason] : null;
}

export interface InvitationsBlockProps {
  invitations: readonly InvitationRow[];
  /** El código de quien mira es reciente: se ofrecen los cambios. */
  canChange: boolean;
  state: InvitationsState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function InvitationsBlock({ invitations, canChange, state, action, pending }: InvitationsBlockProps) {
  const attempt = "attempt" in state ? state.attempt : 0;
  const result = pending ? null : resultOf(state);
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const asked = canChange && state.kind === "confirm" ? state.id : null;
  // La invitación que se iba a revocar ya no está en la lista: se aceptó o alguien la revocó.
  const lost = asked !== null && !invitations.some((invitation) => invitation.id === asked);

  return (
    <section ref={block} id={INVITATIONS_BLOCK_ID} aria-labelledby={TITLE_ID} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <h2 id={TITLE_ID} className="text-h3">
        {text.invitationsTitle}
      </h2>
      <BlockResult
        message={lost ? text.invitationGone : result}
        tone={lost || (state.kind === "failed" && state.reason === "needs_code") ? "warning" : state.kind === "done" ? "success" : "danger"}
        pending={pending}
        pendingText={text.working}
        answer={answer}
        spoken={spoken}
      />
      {invitations.length === 0 ? (
        <p className="text-body-s text-text-2">{text.noInvitations}</p>
      ) : (
        <form action={action} className="flex flex-col gap-4">
          <ul className="flex flex-col gap-3">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-col gap-3 rounded-md border border-border p-4">
                <div className="flex flex-col gap-1">
                  <p className="text-body font-semibold break-all">{invitation.email}</p>
                  <p className="text-body-s">{invitation.what}</p>
                  <p className="text-body-s text-text-2">{invitation.by}</p>
                  {invitation.expires !== null && <p className="text-body-s text-text-2">{invitation.expires}</p>}
                  {invitation.notes.map((note) => (
                    <p key={note} className="text-body-s text-text-2">
                      {note}
                    </p>
                  ))}
                </div>
                {canChange && asked !== invitation.id && (
                  <div className="flex flex-wrap gap-2">
                    {invitation.reinvite !== null && <RowAction button={invitation.reinvite} pending={pending} />}
                    <RowAction button={invitation.revoke} pending={pending} />
                  </div>
                )}
                {asked === invitation.id && (
                  <ConfirmPanel confirmation={invitation.revoke.confirmation} pending={pending} pendingLabel={text.working} box={answer} />
                )}
              </li>
            ))}
          </ul>
        </form>
      )}
    </section>
  );
}
