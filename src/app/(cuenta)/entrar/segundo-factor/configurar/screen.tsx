"use client";

import { MailOpen } from "lucide";
import { type FormEvent, useActionState, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import type { FactorSetupView } from "@/app/_lib/guard-steps";
import { account } from "@/messages/es/account";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { FullScreenState } from "@/ui/full-screen-state";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextField } from "@/ui/text-field";

import { CODE_ERRORS, CodeField } from "../../../_lib/fields";
import { signOutAction } from "../../../_lib/session-actions";
import { SuspendedScreen } from "../../../_lib/states";
import { checkCode } from "../outcomes";
import { SecondFactorExits } from "../screen";

import { confirmSecondFactorAction, startSecondFactorAction } from "./actions";
import type { ConfirmFields, ConfirmState, StartState } from "./outcomes";

// PA-12 · Segundo factor, configurar. Aquí se acepta una invitación de administración.
// Funciona sin JavaScript: cada formulario se envía a su acción de servidor y la página
// vuelve pintada con la respuesta.
//
// Son dos formularios, cada uno con su propio estado, y eso no es un detalle. La respuesta
// de «Empezar» trae la clave, y sin JavaScript React manda el estado de una acción dentro de
// todo formulario ligado a ella: por eso, mientras ese estado trae la clave, no se pinta
// ningún formulario de «Empezar», y «Empezar de nuevo» es un enlace a esta misma ruta. La
// clave se pinta una vez: no va en un campo oculto, no vuelve con la respuesta de confirmar,
// y deja de pintarse al enviar el código y al salir de la página.
//
// No pide códigos de respaldo: Supabase Auth no los da. Un factor perdido lo restablece
// otra persona con configuración (RF-712).

const text = account.factorSetup;
const CODE_ID = "configurar-codigo";
const HANDOFF_ID = "configurar-codigo-dictado";
const START_IDLE: StartState = { kind: "idle" };
const CONFIRM_IDLE: ConfirmState = { kind: "idle" };

const HANDOFF_ERRORS = { required: text.handoffRequired, wrong: text.handoffWrong } as const;

/** Tiene invitación, pero este navegador no trae la prueba de que el buzón es suyo. */
function ProveMailbox({ body }: { body: string }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={MailOpen}
        title={text.proveTitle}
        primaryAction={<Button href={ROUTES.recover}>{text.proveAction}</Button>}
        secondaryActions={
          <>
            <Button href={ROUTES.home} variant="secondary">
              {account.secondFactor.goHome}
            </Button>
            <form action={signOutAction}>
              <Button type="submit" variant="text">
                {account.common.closeSession}
              </Button>
            </form>
          </>
        }
      >
        <p>{body}</p>
      </FullScreenState>
    </main>
  );
}

/**
 * «Empezar de nuevo» cuando la respuesta de «Empezar» que trae la clave sigue siendo el
 * estado de esa acción: un enlace que vuelve a pedir la página, no un formulario. Va como
 * `<a>` a propósito: tiene que ser una carga completa, que es la que suelta ese estado.
 */
function RestartLink() {
  return (
    // Una navegación de cliente conservaría el estado que trae la clave.
    <a href={ROUTES.factorSetup} className="text-body-s text-accent underline underline-offset-4 hover:text-accent-strong">
      {text.startAgain}
    </a>
  );
}

export interface FactorSetupScreenProps {
  /** Lo que la guarda dijo que esta persona ve: probar su buzón, empezar, o seguir con un factor ya empezado. */
  view: FactorSetupView;
}

export function FactorSetupScreen({ view }: FactorSetupScreenProps) {
  const [startState, startAction, starting] = useActionState(startSecondFactorAction, START_IDLE);
  const [answer, confirmAction, confirming] = useActionState(confirmSecondFactorAction, CONFIRM_IDLE);
  // De cuál «Empezar» es la clave que ya no se pinta: la de ese intento, y no la de uno posterior.
  const [hiddenAttempt, setHiddenAttempt] = useState<number | null>(null);
  // Con cuál «Empezar» a la vista se envió el último código.
  const [confirmedWith, setConfirmedWith] = useState<number | null>(null);
  const startedAttempt = startState.kind === "started" ? startState.attempt : null;

  // Los dos estados no saben uno del otro: la respuesta de confirmar se queda como está
  // aunque después llegue una clave nueva. Lo que se contestó con otra clave a la vista ya no
  // dice nada de esta: ni «esa clave ya no es la vigente», ni «ese código no coincide».
  const confirmState: ConfirmState = confirmedWith === startedAttempt ? answer : CONFIRM_IDLE;

  // Al salir de la página la clave deja de pintarse: volver con «atrás» no la enseña otra vez.
  // Se pinta en el acto: el navegador puede congelar la página justo después.
  useEffect(() => {
    const hide = () => flushSync(() => setHiddenAttempt(startedAttempt));
    window.addEventListener("pagehide", hide);
    return () => window.removeEventListener("pagehide", hide);
  }, [startedAttempt]);

  function sent(event: FormEvent<HTMLFormElement>) {
    setConfirmedWith(startedAttempt);
    // Enviado un código, la clave ya cumplió y deja de pintarse. Un envío vacío o sin forma
    // no llega a ser un intento: la persona todavía no la usa, y se queda.
    const code = new FormData(event.currentTarget).get("code");
    if (typeof code === "string" && checkCode(code) === null) setHiddenAttempt(startedAttempt);
  }

  // PA-35: la cuenta se suspendió con la pantalla abierta.
  if (startState.kind === "suspended" || confirmState.kind === "suspended") return <SuspendedScreen withSession />;

  if (view.view === "prove_mailbox" || startState.kind === "needs_mailbox_proof" || confirmState.kind === "needs_mailbox_proof") {
    return <ProveMailbox body={text.proveBody} />;
  }
  // La cuenta ya tiene un factor verificado que nadie ató: probar el buzón otra vez lo borra.
  if (startState.kind === "needs_second_level") return <ProveMailbox body={text.secondLevel} />;

  const started = startState.kind === "started" ? startState : null;
  const shown = started !== null && hiddenAttempt !== started.attempt ? started : null;
  // El factor que esta pantalla pintó: el que acaba de empezar, o el que ese navegador ya traía.
  const painted = started !== null ? started.factorId : view.view === "resume" ? view.painted : null;
  // La clave que la persona tiene delante ya no es la vigente: no tiene caso pedirle su código.
  const stale = confirmState.kind === "start_again";
  const asksCode = painted !== null && !stale;

  const fields: ConfirmFields = confirmState.kind === "invalid" ? confirmState.fields : {};
  const errors: FormError[] = [];
  if (fields.handoff) errors.push({ fieldId: HANDOFF_ID, message: HANDOFF_ERRORS[fields.handoff] });
  if (fields.code) errors.push({ fieldId: CODE_ID, message: CODE_ERRORS[fields.code] });
  const attempt = confirmState.kind === "invalid" || confirmState.kind === "unavailable" || confirmState.kind === "start_again" ? confirmState.attempt : 0;
  const startFailed = startState.kind === "unavailable";

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>

      {stale && (
        <InlineAlert key={`vieja-${attempt}`} tone="warning" live>
          {text.startAgainNotice}
        </InlineAlert>
      )}
      {startFailed && (
        <InlineAlert key={`sin-empezar-${startState.attempt}`} tone="danger" live>
          {account.common.unavailable}
        </InlineAlert>
      )}

      {!asksCode &&
        (started !== null ? (
          <RestartLink />
        ) : (
          <form action={startAction} className="flex flex-col gap-4">
            <p className="text-body-s text-text-2">{text.startNote}</p>
            <Button type="submit" loading={starting} loadingLabel={text.starting}>
              {stale ? text.startAgain : text.start}
            </Button>
          </form>
        ))}

      {asksCode && (
        <>
          {shown !== null ? (
            <ol className="flex list-decimal flex-col gap-6 pl-6">
              <li className="flex flex-col gap-3">
                <p>{text.stepScan}</p>
                {/* Como imagen y nunca incrustado: lo que Auth mande no corre como marcado. */}
                {/* eslint-disable-next-line @next/next/no-img-element -- Es una dirección de datos con la clave: no pasa por el optimizador de imágenes. */}
                {shown.qr !== null && <img src={shown.qr} alt={text.qrAlt} className="size-48" />}
                <p className="flex flex-col gap-1">
                  <span className="text-body-s text-text-2">{text.secretLabel}</span>
                  <code className="break-all text-body-l">{shown.secret}</code>
                </p>
                <p>
                  <a href={shown.uri} className="text-accent underline underline-offset-4 hover:text-accent-strong">
                    {text.openInApp}
                  </a>
                </p>
              </li>
              <li>
                <p>{text.stepCode}</p>
              </li>
            </ol>
          ) : (
            <p className="text-text-2">{text.resumeBody}</p>
          )}

          <form action={confirmAction} noValidate className="flex flex-col gap-6" onSubmit={sent}>
            <FormErrorSummary errors={errors} attempt={attempt} />
            {confirmState.kind === "unavailable" && (
              <InlineAlert key={`fallo-${attempt}`} tone="danger" live>
                {account.common.unavailable}
              </InlineAlert>
            )}
            {/* Lo que esta pantalla pintó. Solo se compara, para no gastar un intento con la clave de otra pestaña. */}
            <input type="hidden" name="painted" value={painted} />
            {view.handoff && (
              <TextField
                key={`dictado-${attempt}`}
                id={HANDOFF_ID}
                label={text.handoff}
                name="handoff"
                autoComplete="off"
                hint={text.handoffHint}
                readOnly={confirming}
                error={fields.handoff ? HANDOFF_ERRORS[fields.handoff] : undefined}
              />
            )}
            <CodeField key={`campo-${attempt}`} id={CODE_ID} problem={fields.code} round={attempt} readOnly={confirming} />
            <Button type="submit" loading={confirming} loadingLabel={text.submitting}>
              {text.submit}
            </Button>
          </form>

          {started !== null ? (
            <RestartLink />
          ) : (
            <form action={startAction}>
              <Button type="submit" variant="text" loading={starting} loadingLabel={text.starting}>
                {text.startAgain}
              </Button>
            </form>
          )}
        </>
      )}

      <SecondFactorExits />
    </main>
  );
}
