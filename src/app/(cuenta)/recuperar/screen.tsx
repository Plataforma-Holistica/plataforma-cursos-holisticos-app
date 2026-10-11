"use client";

import { useActionState } from "react";

import { durationText } from "@/app/_lib/dates";
import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { EMAIL_ERRORS, EmailField } from "../_lib/fields";
import type { MailRequestState } from "../_lib/mail-request";

import { requestRecoveryAction } from "./actions";

// PA-13 · Recuperar contraseña, «pedir». Un campo y un botón. Lo que contesta es lo mismo
// exista o no la cuenta. Funciona sin JavaScript.

const text = account.recover;
const EMAIL_ID = "recuperar-correo";
const IDLE: MailRequestState = { kind: "idle" };

export interface RecoverScreenProps {
  /** El aviso que dejó la pantalla anterior, ya como texto. */
  notice: string | null;
}

export function RecoverScreen({ notice }: RecoverScreenProps) {
  const [state, action, pending] = useActionState(requestRecoveryAction, IDLE);

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const problem = state.kind === "invalid" ? state.field : undefined;
  const errors: FormError[] = problem ? [{ fieldId: EMAIL_ID, message: EMAIL_ERRORS[problem] }] : [];
  const email = state.kind === "invalid" || state.kind === "failed" ? state.email : "";
  const lifetime = state.kind === "sent" && state.lifetimeSeconds !== null ? durationText(state.lifetimeSeconds) : "";

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <div className="flex flex-col gap-3">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-body-l text-text-2">{text.intro}</p>
      </div>
      <form action={action} noValidate className="flex flex-col gap-6">
        {notice !== null && state.kind === "idle" && <InlineAlert tone="warning">{notice}</InlineAlert>}
        <FormErrorSummary errors={errors} attempt={attempt} />
        {state.kind === "sent" && (
          <InlineAlert key={attempt} tone="success" live>
            {lifetime === "" ? text.sent : t(text.sentLasts, { duration: lifetime })}
          </InlineAlert>
        )}
        {state.kind === "failed" && (
          <InlineAlert key={attempt} tone="danger" live>
            {state.reason === "wait" ? account.signUp.wait : account.common.unavailable}
          </InlineAlert>
        )}
        <EmailField key={attempt} id={EMAIL_ID} defaultValue={email} problem={problem} />
        <Button type="submit" loading={pending} loadingLabel={text.submitting}>
          {text.submit}
        </Button>
      </form>
      <p className="text-body-s">
        <TextLink href={ROUTES.signIn}>{text.backToSignIn}</TextLink>
      </p>
    </main>
  );
}
