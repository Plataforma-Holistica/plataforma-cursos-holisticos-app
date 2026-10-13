"use client";

import { KeyRound } from "lucide";
import { useActionState } from "react";

import { account } from "@/messages/es/account";
import { RETURN_PARAM, ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { FullScreenState } from "@/ui/full-screen-state";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { CODE_ERRORS, CodeField, type CodeProblem } from "../../_lib/fields";
import { signOutAction } from "../../_lib/session-actions";
import { SuspendedScreen } from "../../_lib/states";

import { giveCodeAction } from "./actions";
import type { GiveCodeState } from "./outcomes";

// PA-12 · Segundo factor, pedir el código. Funciona sin JavaScript: el formulario se envía a
// una acción de servidor y la página vuelve pintada con su respuesta. El código nunca vuelve:
// el campo se arma vacío con cada intento.
//
// No ofrece códigos de respaldo: Supabase Auth no los da. Quien perdió su aplicación de
// códigos le pide a alguien con configuración que le restablezca el factor (RF-712).

const text = account.secondFactor;
const CODE_ID = "segundo-factor-codigo";
const IDLE: GiveCodeState = { kind: "idle" };

/** Las dos salidas que toda pantalla del segundo factor ofrece: nadie se queda encerrado en ella. */
export function SecondFactorExits() {
  return (
    <div className="flex flex-col items-start gap-3 text-body-s">
      <TextLink href={ROUTES.home}>{text.goHome}</TextLink>
      <form action={signOutAction}>
        <Button type="submit" variant="text">
          {account.common.closeSession}
        </Button>
      </form>
    </div>
  );
}

export interface SecondFactorScreenProps {
  /** El destino guardado (`volver`), tal como llegó: lo valida la acción. */
  returnTo: string;
}

export function SecondFactorScreen({ returnTo }: SecondFactorScreenProps) {
  const [state, action, pending] = useActionState(giveCodeAction, IDLE);

  // PA-35: la cuenta se suspendió con la pantalla abierta.
  if (state.kind === "suspended") return <SuspendedScreen withSession />;

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const problem: CodeProblem | undefined =
    state.kind === "invalid" ? state.problem : state.kind === "failed" && state.reason === "wrong_code" ? "wrong" : undefined;
  const errors: FormError[] = problem ? [{ fieldId: CODE_ID, message: CODE_ERRORS[problem] }] : [];
  const unavailable = state.kind === "failed" && state.reason === "unavailable";

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.body}</p>
      </div>
      <form action={action} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={errors} attempt={attempt} />
        {/* Cada hermano lleva su propia `key`: con la misma, React confunde el aviso de un
            intento con el campo del siguiente. */}
        {unavailable && (
          <InlineAlert key={`fallo-${attempt}`} tone="danger" live>
            {account.common.unavailable}
          </InlineAlert>
        )}
        <input type="hidden" name={RETURN_PARAM} value={returnTo} />
        <CodeField key={`campo-${attempt}`} id={CODE_ID} problem={problem} round={attempt} readOnly={pending} />
        <Button type="submit" loading={pending} loadingLabel={text.submitting}>
          {text.submit}
        </Button>
      </form>
      <SecondFactorExits />
    </main>
  );
}

/**
 * Quien conserva sus capacidades, perdió su atadura y no tiene una invitación viva: no hay
 * código que dar. Se le dice qué pasó y a quién pedírselo.
 */
export function SecondFactorUnboundScreen() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={KeyRound}
        title={text.unboundTitle}
        primaryAction={<Button href={ROUTES.home}>{text.goHome}</Button>}
        secondaryActions={
          <form action={signOutAction}>
            <Button type="submit" variant="secondary">
              {account.common.closeSession}
            </Button>
          </form>
        }
      >
        <p>{text.unboundBody}</p>
      </FullScreenState>
    </main>
  );
}
