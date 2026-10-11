"use client";

import { type FocusEvent, useActionState, useState } from "react";

import { clockTime, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { parseEmail } from "@/services/account/field-rules";
import { RETURN_PARAM, ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { PasswordField } from "@/ui/password-field";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";

import { afterInteraction, useHydrated, useWaitIsOver } from "../_lib/hooks";
import { SuspendedScreen } from "../_lib/states";

import { signInAction } from "./actions";
import type { SignInFields, SignInState } from "./outcomes";

// PA-11 · Iniciar sesión. Funciona sin JavaScript: el formulario se envía a una acción de
// servidor y la página vuelve pintada con su respuesta. Con JavaScript gana el botón que no
// acepta un segundo clic, la validación al salir del campo y la hora en la zona de quien lee.

const text = account.signIn;
const EMAIL_ID = "entrar-correo";
const PASSWORD_ID = "entrar-contrasena";
const IDLE: SignInState = { kind: "idle" };

const EMAIL_ERRORS = { required: account.fields.emailRequired, invalid: account.fields.emailInvalid } as const;

export function ThrottledAlert({ retryAt }: { retryAt: string }) {
  const hydrated = useHydrated();
  // El servidor no sabe en qué zona está la persona: escribe la hora del centro de México
  // y lo dice. El navegador la vuelve a escribir en la suya.
  const message = hydrated
    ? t(text.throttled, { time: clockTime(retryAt) })
    : t(text.throttledCentral, { time: clockTime(retryAt, PRODUCT_TIME_ZONE) });
  return (
    <InlineAlert tone="danger" live>
      {message}
    </InlineAlert>
  );
}

function Fields({ email, fields }: { email: string; fields: SignInFields }) {
  const [emailError, setEmailError] = useState(fields.email);

  // Al salir del campo, y solo si ya trae algo: un campo vacío se marca al enviar.
  function validateOnBlur(event: FocusEvent<HTMLDivElement>) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.name !== "email") return;
    if (field.value.trim() === "") return;
    const seen = parseEmail(field.value).ok ? undefined : "invalid";
    afterInteraction(() => setEmailError(seen));
  }

  return (
    <div className="flex flex-col gap-6" onBlur={validateOnBlur}>
      <TextField
        id={EMAIL_ID}
        label={account.fields.email}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="username"
        defaultValue={email}
        error={emailError ? EMAIL_ERRORS[emailError] : undefined}
      />
      <PasswordField
        id={PASSWORD_ID}
        label={account.fields.password}
        name="password"
        autoComplete="current-password"
        error={fields.password ? account.fields.passwordRequired : undefined}
      />
    </div>
  );
}

export interface SignInScreenProps {
  /** El destino guardado (`volver`), tal como llegó: lo valida la acción. */
  returnTo: string;
  /** El aviso que dejó la pantalla anterior, ya como texto. */
  notice: string | null;
}

export function SignInScreen({ returnTo, notice }: SignInScreenProps) {
  const [state, action, pending] = useActionState(signInAction, IDLE);
  const waitIsOver = useWaitIsOver(state.kind === "throttled" ? state.retryAt : null);

  // PA-35: la contraseña era correcta, pero la cuenta está suspendida. No abre sesión.
  if (state.kind === "suspended") return <SuspendedScreen withSession={false} />;

  const fields: SignInFields = state.kind === "invalid" ? state.fields : {};
  const errors: FormError[] = [];
  if (fields.email) errors.push({ fieldId: EMAIL_ID, message: EMAIL_ERRORS[fields.email] });
  if (fields.password) errors.push({ fieldId: PASSWORD_ID, message: account.fields.passwordRequired });

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const locked = state.kind === "throttled" && !waitIsOver;
  const failure =
    state.kind !== "failed"
      ? null
      : state.reason === "invalid_credentials"
        ? text.invalidCredentials
        : state.reason === "capped"
          ? text.capped
          : account.common.unavailable;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.title}</h1>
      <form action={action} noValidate className="flex flex-col gap-6">
        {notice !== null && state.kind === "idle" && <InlineAlert tone="success">{notice}</InlineAlert>}
        <FormErrorSummary errors={errors} attempt={attempt} />
        {failure !== null && (
          <InlineAlert key={attempt} tone="danger" live>
            {failure}
          </InlineAlert>
        )}
        {state.kind === "throttled" && <ThrottledAlert key={attempt} retryAt={state.retryAt} />}
        <input type="hidden" name={RETURN_PARAM} value={returnTo} />
        <Fields key={attempt} email={state.kind === "idle" ? "" : state.email} fields={fields} />
        <Button
          type="submit"
          loading={pending}
          loadingLabel={text.submitting}
          disabled={locked}
          disabledReason={locked ? text.lockedReason : undefined}
        >
          {text.submit}
        </Button>
      </form>
      <p className="flex flex-col items-start gap-3 text-body-s">
        <TextLink href={ROUTES.recover}>{text.forgot}</TextLink>
        <TextLink href={ROUTES.signUp}>{text.createAccount}</TextLink>
      </p>
    </main>
  );
}
