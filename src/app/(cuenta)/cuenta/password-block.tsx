"use client";

import { type FormEvent, useState } from "react";

import { account } from "@/messages/es/account";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { PasswordField } from "@/ui/password-field";
import { TextLink } from "@/ui/text-link";

import { NewPasswordField, passwordError } from "../_lib/fields";
import { useFocusKept, useLocalChecks, useWaitIsOver } from "../_lib/hooks";
import { ThrottledAlert } from "../_lib/throttled-alert";

import { checkPasswordForm, readPasswordForm, type PasswordFields, type PasswordState } from "./outcomes";

// PA-25 · El bloque «Contraseña». Pide la contraseña actual además de la nueva: una sesión
// abierta no alcanza para cambiarla. Comprobarla pasa por el mismo freno de intentos que la
// pantalla de entrar, y lo dice con sus mismos avisos. Funciona sin JavaScript.
//
// Una contraseña nunca vuelve en una respuesta: después de cada envío los dos campos se
// arman de nuevo, vacíos. Lo que el navegador detiene antes de enviar no cuenta como un
// intento, y deja lo escrito como está.

const text = account.manage;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
export const PASSWORD_BLOCK_ID = "bloque-contrasena";
const TITLE_ID = "cuenta-contrasena-titulo";
const CURRENT_ID = "cuenta-contrasena-actual";
const NEW_ID = "cuenta-contrasena-nueva";

const CURRENT_ERRORS = { required: text.currentPasswordRequired, mismatch: text.currentPasswordMismatch } as const;
const NOTHING: PasswordFields = {};

export interface PasswordBlockProps {
  state: PasswordState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function PasswordBlock({ state, action, pending }: PasswordBlockProps) {
  const sent = "attempt" in state ? state.attempt : 0;
  // Lo que el navegador encontró antes de enviar. Mientras exista, nada se manda.
  const [local, checked] = useLocalChecks<PasswordFields>(sent);
  // La respuesta se pinta aquí mismo: el foco vuelve a donde estaba al enviar.
  const sendingFrom = useFocusKept(sent);
  // Después de qué respuesta se volvió a escribir. Lo que esa respuesta dijo era de otro texto.
  const [editedAfter, setEditedAfter] = useState<number | null>(null);
  const waitIsOver = useWaitIsOver(state.kind === "throttled" ? state.retryAt : null);

  function checkBeforeSending(event: FormEvent<HTMLFormElement>) {
    const found = checkPasswordForm(readPasswordForm(new FormData(event.currentTarget)));
    checked(found);
    // Con algo que corregir no se envía, y lo escrito se queda como está.
    if (found !== null) event.preventDefault();
    else sendingFrom(event.currentTarget);
  }

  // Manda la última revisión: la del navegador, si es más nueva que la respuesta del
  // servidor, y entonces lo que esa respuesta dijo ya no se pinta.
  const fields = local.latest ? (local.found ?? NOTHING) : state.kind === "invalid" ? state.fields : NOTHING;
  // Lo que dijo el último envío deja de decirse mientras hay otro en camino, con algo por
  // corregir y en cuanto se vuelve a escribir: «cambió» junto a una contraseña a medio
  // teclear es de otro intento.
  const answered = !pending && local.found === null && editedAfter !== sent;
  const errors: FormError[] = [];
  if (fields.current) errors.push({ fieldId: CURRENT_ID, message: CURRENT_ERRORS[fields.current] });
  if (fields.next) errors.push({ fieldId: NEW_ID, message: passwordError(fields.next) });
  const round = sent + local.checks;
  // El freno no depende de lo que se escriba: mientras dure la espera, no hay otro intento.
  const locked = state.kind === "throttled" && !waitIsOver;

  return (
    <section id={PASSWORD_BLOCK_ID} aria-labelledby={TITLE_ID} className="flex flex-col gap-4">
      <h2 id={TITLE_ID} className="text-h3">
        {text.passwordTitle}
      </h2>
      <form
        action={action}
        onSubmit={checkBeforeSending}
        onInput={() => setEditedAfter(sent)}
        noValidate
        className="flex flex-col gap-6"
      >
        <FormErrorSummary errors={errors} attempt={round} />
        {/* El resultado va arriba de los campos, no junto al botón: sin JavaScript el navegador
            vuelve al principio del bloque, y más abajo quedaría fuera de una ventana baja.
            Cada hermano lleva su propia `key`: con la misma, el aviso de un intento se quedaría
            en pantalla con el siguiente. */}
        {answered && state.kind === "changed" && (
          <InlineAlert key={`cambio-${sent}`} tone="success" live>
            {text.passwordChanged}
          </InlineAlert>
        )}
        {answered && state.kind === "failed" && (
          <InlineAlert key={`fallo-${sent}`} tone="danger" live>
            {state.reason === "capped" ? account.signIn.capped : account.common.unavailable}
          </InlineAlert>
        )}
        {!pending && state.kind === "throttled" && <ThrottledAlert key={`freno-${sent}`} retryAt={state.retryAt} />}
        {/* Cuando llega la respuesta de un envío, los dos campos se arman de nuevo, vacíos. */}
        <div key={`campos-${sent}`} className="flex flex-col gap-6">
          <PasswordField
            id={CURRENT_ID}
            label={text.currentPassword}
            name="current"
            autoComplete="current-password"
            readOnly={pending}
            error={fields.current ? CURRENT_ERRORS[fields.current] : undefined}
          />
          <NewPasswordField id={NEW_ID} label={account.fields.newPassword} problem={fields.next} round={round} readOnly={pending} />
        </div>
        <Button
          type="submit"
          loading={pending}
          loadingLabel={text.changingPassword}
          disabled={locked}
          disabledReason={locked ? account.signIn.lockedReason : undefined}
        >
          {text.changePassword}
        </Button>
      </form>
      {/* Recuperarla desde el correo no pide la actual, y cierra todas las sesiones. */}
      <p className="text-body-s">
        <TextLink href={ROUTES.recover}>{text.forgotCurrent}</TextLink>
      </p>
    </section>
  );
}
