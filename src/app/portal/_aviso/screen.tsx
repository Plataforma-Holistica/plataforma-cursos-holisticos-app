"use client";

import { useActionState } from "react";

import { portal } from "@/messages/es/portal";
import { RETURN_PARAM } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";

import { acceptNoticeAction } from "./actions";
import type { NoticeState } from "./outcomes";

// El formulario del aviso vuelto a pedir. Lleva el texto que se mostró: si cambió, se vuelve a mostrar.

const text = portal.notice;
const AGREED_ID = "aviso-acepta";
const IDLE: NoticeState = { kind: "idle" };

export function NoticeForm({ notice, returnTo }: { notice: string; returnTo: string }) {
  const [state, action, pending] = useActionState(acceptNoticeAction, IDLE);
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const missing = state.kind === "missing";
  return (
    <form action={action} noValidate className="flex flex-col gap-6">
      <FormErrorSummary errors={missing ? [{ fieldId: AGREED_ID, message: text.missing }] : []} attempt={attempt} />
      {state.kind === "failed" && (
        <InlineAlert key={attempt} tone={state.reason === "changed" ? "warning" : "danger"} live>
          {state.reason === "changed" ? text.changed : text.unknown}
        </InlineAlert>
      )}
      <input type="hidden" name="notice" value={notice} />
      <input type="hidden" name={RETURN_PARAM} value={returnTo} />
      <ConsentCheckbox key={attempt} id={AGREED_ID} name="agreed" label={text.agree} invalid={missing} />
      <Button type="submit" loading={pending} loadingLabel={text.submitting}>
        {text.submit}
      </Button>
    </form>
  );
}
