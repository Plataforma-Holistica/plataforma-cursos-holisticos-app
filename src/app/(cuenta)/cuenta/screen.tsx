"use client";

import { type FormEvent, useActionState } from "react";

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

import { changeNameAction } from "./actions";
import { checkNameForm, readNameForm, type NameProblem, type NameState } from "./outcomes";

// PA-25 · Cuenta. Cada bloque tiene su propio formulario y su propio botón de guardar, y su
// resultado se dice junto a ese botón. Funciona sin JavaScript.
//
// Por ahora, el nombre y el correo a la vista. Dos diferencias con la ficha del diseño,
// decididas el 2026-10-11: el resultado de guardar va en un aviso en línea y no en uno
// flotante, y el correo no se cambia desde aquí hasta que haya correo propio (T-310).

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

export interface AccountScreenProps {
  /** El nombre guardado, como lo leyó la página. */
  name: string;
  /** El correo de la sesión, solo para mostrarlo, o nulo si el token no lo trae. */
  email: string | null;
}

export function AccountScreen({ name, email }: AccountScreenProps) {
  const [state, action, pending] = useActionState(changeNameAction, IDLE, NAME_PERMALINK);
  const sent = "attempt" in state ? state.attempt : 0;
  // Lo que el navegador encontró antes de enviar. Mientras exista, nada se manda.
  const [local, checked] = useLocalChecks<NameProblem>(sent);
  // La respuesta se pinta aquí mismo: el foco vuelve a donde estaba al enviar.
  const sendingFrom = useFocusKept(sent);

  if (state.kind === "suspended") return <SuspendedScreen withSession />;

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
  // Lo que dijo el último envío deja de decirse mientras hay otro en camino.
  const answered = local.found === null && !pending;
  const errors: FormError[] = problem ? [{ fieldId: NAME_ID, message: NAME_ERRORS[problem] }] : [];
  const round = sent + local.checks;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-10 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.title}</h1>
      <section id={NAME_BLOCK_ID} aria-labelledby={NAME_TITLE_ID} className="flex flex-col gap-4">
        <h2 id={NAME_TITLE_ID} className="text-h3">
          {text.nameTitle}
        </h2>
        <form action={action} onSubmit={checkBeforeSending} noValidate className="flex flex-col gap-6">
          <FormErrorSummary errors={errors} attempt={round} />
          {/* Cuando llega la respuesta de un envío, el campo se arma de nuevo con lo que quedó. */}
          <NameField
            key={`campo-${sent}`}
            id={NAME_ID}
            defaultValue={state.kind === "idle" ? name : state.name}
            problem={problem}
            round={round}
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
      <p className="text-body-s">
        <TextLink href={ROUTES.home}>{text.backHome}</TextLink>
      </p>
    </main>
  );
}
