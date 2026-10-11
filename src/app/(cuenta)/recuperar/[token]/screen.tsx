"use client";

import { type FormEvent, useActionState } from "react";

import { account } from "@/messages/es/account";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

import { NewPasswordField, passwordError } from "../../_lib/fields";
import { useLocalChecks } from "../../_lib/hooks";
import { RecoveryLinkDeadScreen, RecoveryUnfinishedScreen } from "../../_lib/states";

import { completeRecoveryAction } from "./actions";
import { checkNewPassword, readChangePasswordForm, type ChangePasswordState, type PasswordProblem } from "./outcomes";

// PA-13 · Recuperar contraseña, «cambiar». Abrir la página no gasta el enlace: se canjea al
// guardar, y solo si la contraseña ya cumple la regla. Funciona sin JavaScript.

const text = account.recover;
const PASSWORD_ID = "recuperar-contrasena";
const IDLE: ChangePasswordState = { kind: "idle" };

export interface ChangePasswordScreenProps {
  /** La huella del enlace, tal como llegó en la dirección: la canjea el servicio al guardar. */
  token: string;
}

export function ChangePasswordScreen({ token }: ChangePasswordScreenProps) {
  const [state, action, pending] = useActionState(completeRecoveryAction, IDLE);
  // Lo que el navegador encontró antes de enviar. Mientras exista, nada se manda.
  const [local, checked] = useLocalChecks<PasswordProblem>();

  if (state.kind === "link_dead") return <RecoveryLinkDeadScreen />;
  if (state.kind === "request_new_link") return <RecoveryUnfinishedScreen />;

  function checkBeforeSending(event: FormEvent<HTMLFormElement>) {
    const problem = checkNewPassword(readChangePasswordForm(new FormData(event.currentTarget)).password);
    checked(problem);
    // No se envía: una contraseña que no cumple la regla no le gasta el enlace a nadie.
    if (problem !== null) event.preventDefault();
  }

  const sent = state.kind === "idle" ? 0 : state.attempt;
  const problem = local.found ?? (state.kind === "invalid" ? state.problem : undefined);
  const errors: FormError[] = problem ? [{ fieldId: PASSWORD_ID, message: passwordError(problem) }] : [];

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.changeTitle}</h1>
      <form action={action} onSubmit={checkBeforeSending} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={errors} attempt={sent + local.failed} />
        {local.found === null && !pending && state.kind === "unavailable" && (
          <InlineAlert key={sent} tone="danger" live>
            {account.common.unavailable}
          </InlineAlert>
        )}
        <input type="hidden" name="token" value={token} />
        {/* Con la respuesta de un envío el campo se arma de nuevo, vacío. */}
        <NewPasswordField
          key={sent}
          id={PASSWORD_ID}
          label={account.fields.newPassword}
          problem={problem}
          round={local.checks}
        />
        <Button type="submit" loading={pending} loadingLabel={text.saving}>
          {text.save}
        </Button>
      </form>
    </main>
  );
}
