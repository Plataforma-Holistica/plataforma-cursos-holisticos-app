"use client";

import { useActionState } from "react";

import { account } from "@/messages/es/account";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { Disclaimer } from "@/ui/disclaimer";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { EMAIL_ERRORS, EmailField } from "../_lib/fields";
import type { MailRequestState } from "../_lib/mail-request";

import { requestRegistrationAction } from "./actions";

// PA-10 · Registro. Un solo campo: el correo. Aquí no se pide nombre ni contraseña y no se
// acepta nada: la cuenta se completa desde el enlace del correo (PA-14). Funciona sin
// JavaScript.

const text = account.signUp;
const EMAIL_ID = "registro-correo";
const IDLE: MailRequestState = { kind: "idle" };

export interface SignUpScreenProps {
  /** Dónde se lee cada texto, o nulo si todavía no tiene página. */
  termsHref: string | null;
  privacyHref: string | null;
}

export function SignUpScreen({ termsHref, privacyHref }: SignUpScreenProps) {
  const [state, action, pending] = useActionState(requestRegistrationAction, IDLE);

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const problem = state.kind === "invalid" ? state.field : undefined;
  const errors: FormError[] = problem ? [{ fieldId: EMAIL_ID, message: EMAIL_ERRORS[problem] }] : [];
  const email = state.kind === "invalid" || state.kind === "failed" ? state.email : "";

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.title}</h1>
      <form action={action} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={errors} attempt={attempt} />
        {/* Cada hermano lleva su propia `key`: con la misma, React confunde el aviso de un
            intento con los campos del siguiente, y el aviso viejo se queda en pantalla. */}
        {state.kind === "failed" && (
          <InlineAlert key={`fallo-${attempt}`} tone="danger" live>
            {state.reason === "wait" ? text.wait : account.common.unavailable}
          </InlineAlert>
        )}
        <EmailField key={`campo-${attempt}`} id={EMAIL_ID} defaultValue={email} problem={problem} hint={text.hint} />
        <Disclaimer variant="signUp" />
        <Button type="submit" loading={pending} loadingLabel={text.submitting}>
          {text.submit}
        </Button>
      </form>
      {/* Son enlaces, sin casilla: aquí no se acepta nada. */}
      <p className="text-body-s text-text-2">
        {text.legalBefore}
        {SPACE}
        {termsHref === null ? (
          text.terms
        ) : (
          <TextLink href={termsHref} external>
            {text.terms}
          </TextLink>
        )}
        {SPACE}
        {text.legalJoin}
        {SPACE}
        {privacyHref === null ? (
          text.privacy
        ) : (
          <TextLink href={privacyHref} external>
            {text.privacy}
          </TextLink>
        )}
        {text.legalEnd}
      </p>
      <p className="text-body-s">
        <TextLink href={ROUTES.signIn}>{text.haveAccount}</TextLink>
      </p>
    </main>
  );
}
