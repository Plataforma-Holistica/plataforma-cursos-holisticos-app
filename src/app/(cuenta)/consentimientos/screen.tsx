"use client";

import { type FormEvent, useActionState, useState } from "react";

import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { RETURN_PARAM } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { SPACE } from "@/ui/cx";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { NAME_ERRORS, NameField } from "../_lib/fields";
import { signOutAction } from "../_lib/session-actions";
import { SuspendedScreen } from "../_lib/states";

import { completeAccountAction } from "./actions";
import {
  acceptName,
  checkConsentsForm,
  readConsentsForm,
  shownValue,
  type ConsentItem,
  type ConsentsFields,
  type ConsentsState,
  type ConsentsView,
} from "./outcomes";

// PA-15 · Consentimientos actualizados. Pide, antes de seguir, solo lo que la guarda dijo
// que le falta a la cuenta. No hay otra salida: leer, aceptar o cerrar sesión.
//
// Ninguna casilla viene marcada, tampoco al volver con un error: por eso, con JavaScript,
// lo que falta se revisa antes de enviar, sin tocar lo ya marcado. Sin JavaScript revisa el
// servidor, y las casillas se marcan de nuevo.

const text = account.consents;
const NAME_ID = "cuenta-nombre";
const ADULT_ID = "cuenta-edad";
const itemId = (docType: string) => `cuenta-texto-${docType}`;
const IDLE: ConsentsState = { kind: "idle" };

function TextConsent({ item, invalid }: { item: ConsentItem; invalid: boolean }) {
  const details = t(text.textDetails, { version: item.version, date: item.effectiveDate });
  if (item.explanation !== null) {
    return (
      <ConsentCheckbox
        variant="explained"
        id={itemId(item.docType)}
        name={acceptName(item.docType)}
        title={item.title}
        description={
          <>
            {item.explanation.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <p>
              {details}
              {item.href !== null && (
                <>
                  {SPACE}
                  <TextLink href={item.href} external>
                    {text.readText}
                  </TextLink>
                </>
              )}
            </p>
          </>
        }
        label={t(text.historyGrant)}
        invalid={invalid}
      />
    );
  }
  return (
    <ConsentCheckbox
      id={itemId(item.docType)}
      name={acceptName(item.docType)}
      label={
        <>
          {t(text.accept, { title: item.title })}
          {SPACE}
          {details}
          {item.href !== null && (
            <>
              {SPACE}
              <TextLink href={item.href} external>
                {text.readText}
              </TextLink>
            </>
          )}
        </>
      }
      invalid={invalid}
    />
  );
}

interface FieldsProps {
  view: ConsentsView;
  name: string;
  fields: ConsentsFields;
  /** Cuenta las revisiones del formulario, las del navegador y las del servidor. */
  round: number;
}

function Fields({ view, name, fields, round }: FieldsProps) {
  return (
    <div className="flex flex-col gap-6">
      {view.askName && <NameField id={NAME_ID} defaultValue={name} problem={fields.name} round={round} />}
      {view.askAdult && (
        <ConsentCheckbox id={ADULT_ID} name="adult" label={t(text.adult, { age: view.minimumAge })} invalid={fields.adult ?? false} />
      )}
      {view.items.map((item) => (
        <TextConsent key={item.documentId} item={item} invalid={fields.texts?.includes(item.docType) ?? false} />
      ))}
    </div>
  );
}

function summaryOf(view: ConsentsView, fields: ConsentsFields): FormError[] {
  const errors: FormError[] = [];
  if (view.askName && fields.name) errors.push({ fieldId: NAME_ID, message: NAME_ERRORS[fields.name] });
  if (view.askAdult && fields.adult) errors.push({ fieldId: ADULT_ID, message: text.adultMissing });
  for (const item of view.items) {
    if (fields.texts?.includes(item.docType)) {
      errors.push({ fieldId: itemId(item.docType), message: t(text.textMissing, { title: item.title }) });
    }
  }
  return errors;
}

export interface ConsentsScreenProps {
  view: ConsentsView;
  /** El destino guardado (`volver`), tal como llegó: lo valida la acción. */
  returnTo: string;
}

export function ConsentsScreen({ view, returnTo }: ConsentsScreenProps) {
  const [state, action, pending] = useActionState(completeAccountAction, IDLE);
  // Lo que el navegador encontró antes de enviar. Mientras exista, nada se manda.
  // `attempt` cuenta todas las revisiones del navegador, también las que salen bien: no
  // retrocede, para que lo visto antes al salir de un campo no vuelva a mandar.
  const [local, setLocal] = useState<{ fields: ConsentsFields | null; attempt: number }>({ fields: null, attempt: 0 });

  if (state.kind === "suspended") return <SuspendedScreen withSession />;

  function checkBeforeSending(event: FormEvent<HTMLFormElement>) {
    const input = readConsentsForm(new FormData(event.currentTarget));
    const fields = checkConsentsForm(view, input);
    if (fields === null) {
      setLocal((current) => ({ fields: null, attempt: current.attempt + 1 }));
      return;
    }
    // No se envía, así que el formulario no se vacía: lo marcado se queda marcado.
    event.preventDefault();
    setLocal((current) => ({ fields, attempt: current.attempt + 1 }));
  }

  const sent = state.kind === "idle" ? 0 : state.attempt;
  const round = sent + local.attempt;
  const fields = local.fields ?? (state.kind === "invalid" ? state.fields : {});
  // Lo que dijo el último envío deja de decirse mientras hay otro en camino.
  const answered = local.fields === null && !pending;
  const name = state.kind === "idle" ? "" : state.name;
  const updated = view.variant === "updated_texts";

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <div className="flex flex-col gap-3">
        <h1 className="text-h1">{updated ? text.titleUpdated : text.titleComplete}</h1>
        <p className="text-body-l text-text-2">{updated ? text.introUpdated : text.introComplete}</p>
      </div>
      <form action={action} onSubmit={checkBeforeSending} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={summaryOf(view, fields)} attempt={round} />
        {answered && state.kind === "repainted" && state.reason === "texts_changed" && (
          <InlineAlert key={sent} tone="warning" live>
            {text.textsChanged}
          </InlineAlert>
        )}
        {answered && state.kind === "unavailable" && (
          <InlineAlert key={sent} tone="danger" live>
            {account.common.unavailable}
          </InlineAlert>
        )}
        <input type="hidden" name={RETURN_PARAM} value={returnTo} />
        {view.items.map((item) => (
          <input key={item.documentId} type="hidden" name="shown" value={shownValue(item)} />
        ))}
        {/* Cuando cambian los textos, o llega la respuesta de un envío, los campos se arman de nuevo. */}
        <Fields key={`${view.signature}:${sent}`} view={view} name={name} fields={fields} round={round} />
        <Button type="submit" loading={pending} loadingLabel={text.submitting}>
          {text.submit}
        </Button>
      </form>
      <form action={signOutAction}>
        <Button type="submit" variant="text">
          {account.common.closeSession}
        </Button>
      </form>
    </main>
  );
}
