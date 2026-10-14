"use client";

import { useActionState, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { admin } from "@/messages/es/admin";
import { ROUTES } from "@/services/account/navigation";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { CodeBlock } from "../_lib/code-block";

import { freshCodeAction, invitationsAction, inviteAction, resetAction, teamAction } from "./actions";
import { INVITATIONS_BLOCK_ID, InvitationsBlock } from "./invitations-block";
import { INVITE_BLOCK_ID, InviteBlock } from "./invite-block";
import { MEMBERS_BLOCK_ID, MembersBlock } from "./members-block";
import type { CodeState, InvitationsState, InviteState, ResetState, TeamState } from "./outcomes";
import { RESET_BLOCK_ID, ResetBlock } from "./reset-block";
import type { TeamView } from "./rows";

// PA-86 · El equipo de administración. Va por bloques, cada uno con su formulario, su acción
// y su estado, y su resultado se dice en el bloque. Funciona sin JavaScript.
//
// Diferencias con la ficha del diseño, decididas el 2026-10-13: sin tabla ni diálogo (una
// lista por persona, y la confirmación en dos pasos dentro de la fila), y sin correo de
// invitación (la pantalla le dice a quien invita qué avisarle a la persona).
//
// Los cambios se ofrecen solo cuando la página leyó que el código de quien mira es reciente.
// Si no lo es, arriba va el bloque para darlo otra vez: lo decide el dato de la página, nunca
// lo que haya contestado otro bloque.

const text = admin.team;
const CODE_IDLE: CodeState = { kind: "idle" };
const INVITE_IDLE: InviteState = { kind: "idle" };
const TEAM_IDLE: TeamState = { kind: "idle" };
const INVITATIONS_IDLE: InvitationsState = { kind: "idle" };
const RESET_IDLE: ResetState = { kind: "idle" };
// El bloque «Tu código», que es el compartido: sus `id` son de esta pantalla.
const CODE_BLOCK_ID = "bloque-equipo-codigo";
const CODE_TITLE_ID = "equipo-codigo-titulo";
const CODE_FIELD_ID = "equipo-codigo";
// A dónde vuelve el navegador cuando un formulario se envía sin JavaScript: a esta misma
// pantalla, parado en el bloque que envió.
const CODE_PERMALINK = `${ROUTES.team}#${CODE_BLOCK_ID}`;
const INVITE_PERMALINK = `${ROUTES.team}#${INVITE_BLOCK_ID}`;
const MEMBERS_PERMALINK = `${ROUTES.team}#${MEMBERS_BLOCK_ID}`;
const INVITATIONS_PERMALINK = `${ROUTES.team}#${INVITATIONS_BLOCK_ID}`;
const RESET_PERMALINK = `${ROUTES.team}#${RESET_BLOCK_ID}`;

export interface TeamScreenProps {
  /** El equipo, ya puesto en palabras por la página. */
  view: TeamView;
}

export function TeamScreen({ view }: TeamScreenProps) {
  const [code, codeAction, codePending] = useActionState(freshCodeAction, CODE_IDLE, CODE_PERMALINK);
  const [invite, sendInvite, invitePending] = useActionState(inviteAction, INVITE_IDLE, INVITE_PERMALINK);
  const [team, sendTeam, teamPending] = useActionState(teamAction, TEAM_IDLE, MEMBERS_PERMALINK);
  const [invitations, sendInvitations, invitationsPending] = useActionState(invitationsAction, INVITATIONS_IDLE, INVITATIONS_PERMALINK);
  const [reset, sendReset, resetPending] = useActionState(resetAction, RESET_IDLE, RESET_PERMALINK);
  // De cuál respuesta es el código dictado que está a la vista, y de cuál ya no se pinta.
  const shownCode = reset.kind === "code" ? reset.attempt : null;
  const [hiddenCode, setHiddenCode] = useState<number | null>(null);

  // Al salir de la página el código deja de pintarse: volver con «atrás» no lo enseña otra
  // vez. Se pinta en el acto: el navegador puede congelar la página justo después.
  useEffect(() => {
    const hide = () => flushSync(() => setHiddenCode(shownCode));
    window.addEventListener("pagehide", hide);
    return () => window.removeEventListener("pagehide", hide);
  }, [shownCode]);

  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      // El siguiente envío de cualquier bloque también lo esconde: ya cumplió.
      onSubmitCapture={() => setHiddenCode(shownCode)}
      className="mx-auto flex max-w-form flex-col gap-10 px-4 py-16 outline-none"
    >
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
      <InviteBlock capabilities={view.capabilities} canChange={view.canChange} state={invite} action={sendInvite} pending={invitePending} />
      <MembersBlock members={view.members} canChange={view.canChange} state={team} action={sendTeam} pending={teamPending} />
      <InvitationsBlock
        invitations={view.invitations}
        canChange={view.canChange}
        state={invitations}
        action={sendInvitations}
        pending={invitationsPending}
      />
      <ResetBlock
        options={view.resettable}
        canChange={view.canChange}
        state={reset}
        codeHidden={shownCode !== null && hiddenCode === shownCode}
        action={sendReset}
        pending={resetPending}
      />
      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}
