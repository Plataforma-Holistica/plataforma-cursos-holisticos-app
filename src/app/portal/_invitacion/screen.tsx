"use client";

import { useActionState } from "react";

import { portal } from "@/messages/es/portal";
import { Button } from "@/ui/button";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";

import { acceptInvitationAction } from "./actions";
import type { InvitationFailure, InvitationState } from "./outcomes";

// El formulario de PA-40. Ninguna casilla viene marcada, tampoco al volver con un error. Lleva los dos textos
// que la pantalla mostró, para que la base compare: si cambiaron, se vuelven a mostrar.

const text = portal.invitation;
const AGREED_ID = "invitacion-contrato";
const NOTICE_ID = "invitacion-aviso";
const IDLE: InvitationState = { kind: "idle" };

const FAILURES: Record<InvitationFailure, { tone: "warning" | "danger"; message: string }> = {
  changed: { tone: "warning", message: text.changed },
  unavailable: { tone: "danger", message: text.noTexts },
  unknown: { tone: "danger", message: text.unknown },
};

export function InvitationForm({ agreement, notice }: { agreement: string; notice: string }) {
  const [state, action, pending] = useActionState(acceptInvitationAction, IDLE);
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const errors: FormError[] = [];
  if (state.kind === "missing" && !state.agreed) errors.push({ fieldId: AGREED_ID, message: text.agreeMissing });
  if (state.kind === "missing" && !state.noticeAgreed) errors.push({ fieldId: NOTICE_ID, message: text.noticeMissing });

  return (
    <form action={action} noValidate className="flex flex-col gap-6">
      <FormErrorSummary errors={errors} attempt={attempt} />
      {state.kind === "failed" && (
        <InlineAlert key={attempt} tone={FAILURES[state.reason].tone} live>
          {FAILURES[state.reason].message}
        </InlineAlert>
      )}
      <input type="hidden" name="agreement" value={agreement} />
      <input type="hidden" name="notice" value={notice} />
      <div key={attempt} className="flex flex-col gap-4">
        <ConsentCheckbox id={AGREED_ID} name="agreed" label={text.agree} invalid={state.kind === "missing" && !state.agreed} />
        <ConsentCheckbox id={NOTICE_ID} name="notice_agreed" label={text.agreeNotice} invalid={state.kind === "missing" && !state.noticeAgreed} />
      </div>
      <Button type="submit" loading={pending} loadingLabel={text.submitting}>
        {text.submit}
      </Button>
    </form>
  );
}
