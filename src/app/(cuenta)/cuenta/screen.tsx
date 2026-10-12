"use client";

import { type FormEvent, useActionState, useState } from "react";

import { account } from "@/messages/es/account";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { NAME_ERRORS, NameField } from "../_lib/fields";
import { useFocusKept, useLocalChecks } from "../_lib/hooks";
import { SuspendedScreen } from "../_lib/states";

import { changeNameAction, changePasswordAction, closeSessionsAction } from "./actions";
import {
  checkNameForm,
  readNameForm,
  type NameProblem,
  type NameState,
  type PasswordState,
  type SessionsState,
} from "./outcomes";
import { PASSWORD_BLOCK_ID, PasswordBlock } from "./password-block";
import type { SessionRow } from "./rows";
import { SESSIONS_BLOCK_ID, SessionsBlock } from "./sessions-block";

// PA-25 · Cuenta. Cada bloque tiene su propio formulario y su propio botón de guardar, y su
// resultado se dice junto a ese botón. Funciona sin JavaScript.
//
// El nombre, el correo a la vista, la contraseña y las sesiones abiertas. Dos diferencias con
// la ficha del diseño, decididas el 2026-10-11: el resultado de guardar va en un aviso en
// línea y no en uno flotante, y el correo no se cambia desde aquí hasta que haya correo
// propio (T-310).
//
// Los estados de todos los bloques viven aquí arriba, y no en cada bloque: cualquiera de
// ellos puede contestar que la cuenta está suspendida, y eso sustituye a la pantalla entera.

const text = account.manage;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
const NAME_BLOCK_ID = "bloque-nombre";
const NAME_ID = "cuenta-nombre";
const NAME_TITLE_ID = "cuenta-nombre-titulo";
const EMAIL_TITLE_ID = "cuenta-correo-titulo";
const IDLE: NameState = { kind: "idle" };
// A dónde vuelve el navegador cuando el formulario se envía sin JavaScript: a esta misma
// pantalla, parado en el bloque que envió. Sin el ancla volvería al principio de la página,
// y lo que contestó un bloque de más abajo quedaría fuera de la vista.
const NAME_PERMALINK = `${ROUTES.account}#${NAME_BLOCK_ID}`;
const SESSIONS_PERMALINK = `${ROUTES.account}#${SESSIONS_BLOCK_ID}`;
const SESSIONS_IDLE: SessionsState = { kind: "idle" };
const PASSWORD_PERMALINK = `${ROUTES.account}#${PASSWORD_BLOCK_ID}`;
const PASSWORD_IDLE: PasswordState = { kind: "idle" };

export interface AccountScreenProps {
  /** El nombre guardado, como lo leyó la página. */
  name: string;
  /** El correo de la sesión, solo para mostrarlo, o nulo si el token no lo trae. */
  email: string | null;
  /** Las sesiones abiertas de la cuenta, ya puestas en palabras. La de ahora siempre viene. */
  sessions: readonly SessionRow[];
  /** La cuenta tiene un segundo factor verificado: su contraseña se cambia recuperándola. */
  secondFactor?: boolean;
}

export function AccountScreen({ name, email, sessions, secondFactor = false }: AccountScreenProps) {
  const [state, action, pending] = useActionState(changeNameAction, IDLE, NAME_PERMALINK);
  const [closing, closeAction, closingPending] = useActionState(closeSessionsAction, SESSIONS_IDLE, SESSIONS_PERMALINK);
  const [password, passwordAction, passwordPending] = useActionState(changePasswordAction, PASSWORD_IDLE, PASSWORD_PERMALINK);
  const sent = "attempt" in state ? state.attempt : 0;
  // Lo que el navegador encontró antes de enviar. Mientras exista, nada se manda.
  const [local, checked] = useLocalChecks<NameProblem>(sent);
  // La respuesta se pinta aquí mismo: el foco vuelve a donde estaba al enviar.
  const sendingFrom = useFocusKept(sent);
  // Después de qué respuesta se volvió a escribir. Lo que esa respuesta dijo era de otro texto.
  const [editedAfter, setEditedAfter] = useState<number | null>(null);

  if (state.kind === "suspended" || closing.kind === "suspended" || password.kind === "suspended") {
    return <SuspendedScreen withSession />;
  }

  function checkBeforeSending(event: FormEvent<HTMLFormElement>) {
    const found = checkNameForm(readNameForm(new FormData(event.currentTarget)));
    checked(found);
    // Con algo que corregir no se envía, y lo escrito se queda como está.
    if (found !== null) event.preventDefault();
    else sendingFrom(event.currentTarget);
  }

  // Manda la última revisión: la del navegador, si es más nueva que la respuesta del
  // servidor, y entonces lo que esa respuesta dijo ya no se pinta.
  const problem = local.latest ? (local.found ?? undefined) : state.kind === "invalid" ? state.problem : undefined;
  // Lo que dijo el último envío deja de decirse mientras hay otro en camino, y en cuanto
  // lo escrito ya es otra cosa: «Guardado» junto a un nombre que no se ha guardado miente.
  // Tampoco con algo por corregir: lo escrito puede haber cambiado sin avisar (antes de
  // que React tomara el formulario, o porque lo llenó el navegador), y entonces lo que se
  // entera es la revisión antes de enviar.
  const answered = !pending && local.found === null && editedAfter !== sent;
  const errors: FormError[] = problem ? [{ fieldId: NAME_ID, message: NAME_ERRORS[problem] }] : [];
  const round = sent + local.checks;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-10 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.title}</h1>
      <section id={NAME_BLOCK_ID} aria-labelledby={NAME_TITLE_ID} className="flex flex-col gap-4">
        <h2 id={NAME_TITLE_ID} className="text-h3">
          {text.nameTitle}
        </h2>
        <form
          action={action}
          onSubmit={checkBeforeSending}
          onInput={() => setEditedAfter(sent)}
          noValidate
          className="flex flex-col gap-6"
        >
          <FormErrorSummary errors={errors} attempt={round} />
          {/* Cuando llega la respuesta de un envío, el campo se arma de nuevo con lo que quedó. */}
          <NameField
            key={`campo-${sent}`}
            id={NAME_ID}
            defaultValue={state.kind === "idle" ? name : state.name}
            problem={problem}
            round={round}
            readOnly={pending}
          />
          {/* Cada hermano lleva su propia `key`: con la misma, el aviso de un intento se
              quedaría en pantalla con el siguiente. */}
          {answered && state.kind === "saved" && (
            <InlineAlert key={`guardado-${sent}`} tone="success" live>
              {text.saved}
            </InlineAlert>
          )}
          {answered && state.kind === "unavailable" && (
            <InlineAlert key={`fallo-${sent}`} tone="danger" live>
              {account.common.unavailable}
            </InlineAlert>
          )}
          <Button type="submit" loading={pending} loadingLabel={text.saving}>
            {text.save}
          </Button>
        </form>
      </section>
      <section aria-labelledby={EMAIL_TITLE_ID} className="flex flex-col gap-2">
        <h2 id={EMAIL_TITLE_ID} className="text-h3">
          {text.emailTitle}
        </h2>
        {email !== null && <p>{email}</p>}
        <p className="text-body-s text-text-2">{text.emailNote}</p>
      </section>
      <PasswordBlock recoverOnly={secondFactor} state={password} action={passwordAction} pending={passwordPending} />
      <SessionsBlock sessions={sessions} state={closing} action={closeAction} pending={closingPending} />
      <p className="text-body-s">
        <TextLink href={ROUTES.home}>{text.backHome}</TextLink>
      </p>
    </main>
  );
}
