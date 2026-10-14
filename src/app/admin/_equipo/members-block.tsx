"use client";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { SPACE } from "@/ui/cx";

import type { TeamFailure, TeamState } from "./outcomes";
import { BlockResult, ConfirmPanel, RowAction, useAnswerFocus } from "./parts";
import type { MemberRow } from "./rows";

// PA-86 · El bloque «El equipo». Una fila por persona, con sus capacidades y sus botones.
// No lleva tabla ni diálogo (decisión del 2026-10-13): quitar una capacidad y dar
// configuración se confirman en dos pasos dentro de la fila.
//
// Todo el bloque es un solo formulario, y cada botón dice lo suyo con su valor: así funciona
// sin JavaScript y el bloque tiene un solo estado. Lo que el formulario manda es qué botón
// se pulsó: a quién, y qué capacidad. Nada de eso decide quién actúa.

const text = admin.team;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
export const MEMBERS_BLOCK_ID = "bloque-equipo-personas";
const TITLE_ID = "equipo-personas-titulo";

const DONE = { granted: text.granted, revoked: text.revoked } as const;
const FAILURES: Record<TeamFailure, string> = {
  already_has: text.alreadyHas,
  not_held: text.notHeld,
  min_config: text.minConfig,
  not_member: text.grantNotMember,
  ineligible: text.grantIneligible,
  invalid: text.invalid,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

/** Lo que contestó el último envío, en palabras. Nulo si no hay nada que decir. */
function resultOf(state: TeamState): string | null {
  if (state.kind === "done") return DONE[state.what];
  return state.kind === "failed" ? FAILURES[state.reason] : null;
}

export interface MembersBlockProps {
  members: readonly MemberRow[];
  /** El código de quien mira es reciente: se ofrecen los cambios. */
  canChange: boolean;
  state: TeamState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function MembersBlock({ members, canChange, state, action, pending }: MembersBlockProps) {
  const attempt = "attempt" in state ? state.attempt : 0;
  const result = pending ? null : resultOf(state);
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const asked = canChange && state.kind === "confirm" ? state : null;
  // Lo que se pregunta sale de la lista de ahora: si la fila ya no ofrece eso, la lista cambió.
  const confirmationOf = (member: MemberRow) =>
    asked?.intent.profile === member.id
      ? (member.capabilities.find((row) => row.capability === asked.intent.capability && row.held === (asked.intent.type === "revoke"))
          ?.confirmation ?? null)
      : null;
  const lost = asked !== null && !members.some((member) => confirmationOf(member) !== null);

  return (
    <section ref={block} id={MEMBERS_BLOCK_ID} aria-labelledby={TITLE_ID} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <h2 id={TITLE_ID} className="text-h3">
        {text.membersTitle}
      </h2>
      {!canChange && <p className="text-body-s text-text-2">{text.changesLocked}</p>}
      <BlockResult
        message={lost ? text.listChanged : result}
        tone={lost || (state.kind === "failed" && state.reason === "needs_code") ? "warning" : state.kind === "done" ? "success" : "danger"}
        pending={pending}
        pendingText={text.working}
        answer={answer}
        spoken={spoken}
      />
      <form action={action} className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          {members.map((member) => {
            const confirmation = confirmationOf(member);
            const buttons = member.capabilities.filter((row) => row.button !== null);
            const locks = [...new Set(member.capabilities.map((row) => row.locked).filter((reason) => reason !== null))];
            return (
              <li key={member.id} className="flex flex-col gap-3 rounded-md border border-border p-4">
                <div className="flex flex-col gap-1">
                  <p className="text-body font-semibold break-all">
                    {member.email}
                    {member.self && (
                      <>
                        {SPACE}
                        <span className="text-body-s font-normal text-text-2">{text.self}</span>
                      </>
                    )}
                  </p>
                  {member.name !== null && <p className="text-body-s text-text-2">{member.name}</p>}
                  <p className="text-body-s">{member.holds}</p>
                  {member.notes.map((note) => (
                    <p key={note} className="text-body-s text-text-2">
                      {note}
                    </p>
                  ))}
                </div>
                {canChange && confirmation === null && (
                  <>
                    {buttons.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {buttons.map((row) => row.button !== null && <RowAction key={row.capability} button={row.button} pending={pending} />)}
                      </div>
                    )}
                    {locks.map((reason) => (
                      <p key={reason} className="text-body-s text-text-2">
                        {reason}
                      </p>
                    ))}
                  </>
                )}
                {confirmation !== null && (
                  <ConfirmPanel confirmation={confirmation} changed={asked?.changed} pending={pending} pendingLabel={text.working} box={answer} />
                )}
              </li>
            );
          })}
        </ul>
      </form>
    </section>
  );
}
