"use client";

import { MailCheck } from "lucide";
import { useActionState } from "react";

import { durationText } from "@/app/_lib/dates";
import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { FullScreenState } from "@/ui/full-screen-state";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { useDelayIsOver } from "../_lib/hooks";

import { notMyEmailAction, resendAction } from "./actions";
import type { ResendState, ResendWait } from "./outcomes";

// PA-14 · Correo sin verificar, variante «Revisa tu correo». A donde lleva siempre el
// registro, se haya mandado un correo o no: por eso la línea de «¿Ya tenías cuenta?» va
// siempre. Funciona sin JavaScript: «Reenviar» y «Ese no es mi correo» son envíos.

const text = account.checkMail;
const IDLE: ResendState = { kind: "idle" };

export interface CheckMailScreenProps {
  /** El correo anotado en este navegador, o nulo si no hay ninguno. */
  email: string | null;
  /** Lo que dura el enlace, en segundos, o nulo si no se supo. */
  lifetimeSeconds: number | null;
  /** La espera que le queda a «Reenviar» al pintar la página, o nulo. */
  wait: ResendWait | null;
}

function Resend({ wait: initialWait }: { wait: ResendWait | null }) {
  const [state, action, pending] = useActionState(resendAction, IDLE);
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  // Después de un reenvío, la espera es la que contestó la acción, y se cuenta de nuevo.
  const wait = state.kind === "sent" ? state.wait : initialWait;
  const waitIsOver = useDelayIsOver(wait?.remainingMs ?? null, state.kind === "sent" ? attempt : 0);
  const locked = wait !== null && !waitIsOver;

  return (
    <div className="flex w-full flex-col gap-4">
      {state.kind === "sent" && (
        <InlineAlert key={attempt} tone="success" live>
          {text.resent}
        </InlineAlert>
      )}
      {state.kind === "failed" && (
        <InlineAlert key={attempt} tone="danger" live>
          {state.reason === "wait" ? account.signUp.wait : account.common.unavailable}
        </InlineAlert>
      )}
      <div className="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-start">
        <form action={action}>
          <Button
            type="submit"
            loading={pending}
            loadingLabel={text.resending}
            disabled={locked}
            disabledReason={locked ? t(text.resendWait, { duration: durationText(wait.seconds) }) : undefined}
          >
            {text.resend}
          </Button>
        </form>
        <form action={notMyEmailAction}>
          <Button type="submit" variant="text">
            {text.notMyEmail}
          </Button>
        </form>
      </div>
    </div>
  );
}

export function CheckMailScreen({ email, lifetimeSeconds, wait }: CheckMailScreenProps) {
  const lifetime = lifetimeSeconds === null ? "" : durationText(lifetimeSeconds);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={MailCheck}
        title={text.title}
        primaryAction={email === null ? <Button href={ROUTES.signUp}>{text.writeAgain}</Button> : <Resend wait={wait} />}
        help={
          <p className="text-text-2">
            {text.alreadyBefore}
            {SPACE}
            <TextLink href={ROUTES.signIn}>{text.alreadySignIn}</TextLink>
            {SPACE}
            {text.alreadyJoin}
            {SPACE}
            <TextLink href={ROUTES.recover}>{text.alreadyRecover}</TextLink>
            {text.alreadyEnd}
          </p>
        }
      >
        <p>{email === null ? text.sentGeneric : t(text.sentTo, { email })}</p>
        {lifetime !== "" && <p>{t(text.lasts, { duration: lifetime })}</p>}
      </FullScreenState>
    </main>
  );
}
