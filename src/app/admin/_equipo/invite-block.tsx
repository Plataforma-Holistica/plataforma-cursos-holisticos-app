"use client";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { FieldError } from "@/ui/field";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { TextField } from "@/ui/text-field";

import type { InviteFailure, InviteState } from "./outcomes";
import type { TeamView } from "./rows";

// PA-86 · El bloque «Invitar». La invitación no manda ningún correo (decisión del
// 2026-10-13): al crearla, el bloque le dice a quien invita qué avisarle a la persona, según
// tenga cuenta o no. Lo escrito vuelve con cada respuesta que no sea «hecho».

const text = admin.team;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
export const INVITE_BLOCK_ID = "bloque-equipo-invitar";
const TITLE_ID = "equipo-invitar-titulo";
const EMAIL_ID = "equipo-invitar-correo";
const CAPABILITIES_ID = "equipo-invitar-capacidades";
const CAPABILITIES_ERROR_ID = "equipo-invitar-capacidades-error";

const EMAIL_ERRORS = { required: text.inviteEmailRequired, invalid: text.inviteEmailInvalid } as const;
const FAILURES: Record<InviteFailure, string> = {
  already_invited: text.alreadyInvited,
  already_member: text.alreadyMember,
  ineligible: text.inviteIneligible,
  not_configured: text.notConfigured,
  invalid: text.invalid,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

export interface InviteBlockProps {
  capabilities: TeamView["capabilities"];
  /** El código de quien mira es reciente: se ofrece el botón. */
  canChange: boolean;
  state: InviteState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function InviteBlock({ capabilities, canChange, state, action, pending }: InviteBlockProps) {
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const problems = state.kind === "invalid" ? state.problems : {};
  // Lo escrito vuelve, salvo cuando ya se invitó: entonces el formulario queda limpio.
  const typed = state.kind === "invalid" || state.kind === "failed" ? state : { email: "", capabilities: [] as string[] };
  const errors: FormError[] = [];
  if (problems.email) errors.push({ fieldId: EMAIL_ID, message: EMAIL_ERRORS[problems.email] });
  if (problems.capabilities) errors.push({ fieldId: CAPABILITIES_ID, message: text.inviteCapabilitiesRequired });

  return (
    <section id={INVITE_BLOCK_ID} aria-labelledby={TITLE_ID} className="flex flex-col gap-4">
      <h2 id={TITLE_ID} className="text-h3">
        {text.inviteTitle}
      </h2>
      <p className="text-body-s text-text-2">{text.inviteIntro}</p>
      <form action={action} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={errors} attempt={attempt} />
        {/* Cada hermano lleva su propia `key`: con la misma, el aviso de un intento se
            quedaría en pantalla con el siguiente. */}
        {!pending && state.kind === "done" && (
          <InlineAlert key={`hecho-${attempt}`} tone="success" live>
            {state.answer === "invited_new"
              ? t(text.invitedNew, { email: state.email, path: ROUTES.signUp })
              : t(text.invitedExisting, { email: state.email, path: ROUTES.recover })}
          </InlineAlert>
        )}
        {!pending && state.kind === "failed" && (
          <InlineAlert key={`fallo-${attempt}`} tone={state.reason === "needs_code" ? "warning" : "danger"} live>
            {FAILURES[state.reason]}
          </InlineAlert>
        )}
        {/* Con cada respuesta los campos se arman de nuevo, con lo que quedó. */}
        <TextField
          key={`correo-${attempt}`}
          id={EMAIL_ID}
          label={text.inviteEmail}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          defaultValue={typed.email}
          readOnly={pending}
          error={problems.email ? EMAIL_ERRORS[problems.email] : undefined}
        />
        <fieldset
          key={`capacidades-${attempt}`}
          id={CAPABILITIES_ID}
          tabIndex={-1}
          aria-describedby={problems.capabilities ? CAPABILITIES_ERROR_ID : undefined}
          className="flex flex-col gap-1 outline-none"
        >
          <legend className="text-body font-semibold">{text.inviteCapabilities}</legend>
          {capabilities.map((capability) => (
            <Checkbox
              key={capability.value}
              name="capability"
              value={capability.value}
              label={capability.label}
              defaultChecked={typed.capabilities.includes(capability.value)}
            />
          ))}
          {problems.capabilities && <FieldError id={CAPABILITIES_ERROR_ID}>{text.inviteCapabilitiesRequired}</FieldError>}
        </fieldset>
        {canChange ? (
          <Button type="submit" loading={pending} loadingLabel={text.inviteSubmitting}>
            {text.inviteSubmit}
          </Button>
        ) : (
          <p className="text-body-s text-text-2">{text.changesLocked}</p>
        )}
      </form>
    </section>
  );
}
