"use client";

import { type FormEvent, useActionState } from "react";

import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { SPACE } from "@/ui/cx";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { NAME_ERRORS, NameField, NewPasswordField, passwordError } from "../../_lib/fields";
import { useLocalChecks } from "../../_lib/hooks";
import { NoCurrentTextScreen, RegistrationLinkDeadScreen, RegistrationUnfinishedScreen } from "../../_lib/states";
import { shownValue, type ConsentItem } from "../../consentimientos/outcomes";

import { completeRegistrationAction } from "./actions";
import {
  checkCompleteForm,
  readCompleteForm,
  type CompleteFields,
  type CompleteState,
  type CompleteView,
  type ConsentBox,
} from "./outcomes";

// PA-14 · Correo sin verificar, variante «Completa tu cuenta». Abrir la página no gasta el
// enlace: se canjea al enviar, y solo si los datos y los textos ya están en orden.
//
// Ninguna casilla viene marcada, tampoco al volver con un error: por eso, con JavaScript,
// lo que falta se revisa antes de enviar, sin tocar lo ya escrito ni lo ya marcado. Sin
// JavaScript revisa el servidor, y las casillas y la contraseña se llenan de nuevo.

const text = account.complete;
const consents = account.consents;
const NAME_ID = "completar-nombre";
const PASSWORD_ID = "completar-contrasena";
const ADULT_ID = "completar-edad";
const boxId = (name: string) => `completar-${name.replace(/[^a-z_]/g, "-")}`;
const IDLE: CompleteState = { kind: "idle" };

function TextReference({ item, label }: { item: ConsentItem; label: string }) {
  if (item.href === null) return label;
  return (
    <TextLink href={item.href} external>
      {label}
    </TextLink>
  );
}

function Box({ box, invalid }: { box: ConsentBox; invalid: boolean }) {
  const [first] = box.items;
  if (first === undefined) return null;

  // «Acepto los Términos y el Aviso de privacidad.», con el enlace a cada texto.
  const terms = box.items.find((item) => item.docType === "terms");
  const privacy = box.items.find((item) => item.docType === "student_privacy_notice");
  if (box.kind === "legal" && terms !== undefined && privacy !== undefined) {
    return (
      <ConsentCheckbox
        id={boxId(box.name)}
        name={box.name}
        label={
          <>
            {text.acceptBefore}
            {SPACE}
            <TextReference item={terms} label={account.signUp.terms} />
            {SPACE}
            {text.acceptJoin}
            {SPACE}
            <TextReference item={privacy} label={account.signUp.privacy} />
            {text.acceptEnd}
          </>
        }
        invalid={invalid}
      />
    );
  }

  const details = t(consents.textDetails, { version: first.version, date: first.effectiveDate });
  const read = first.href !== null && (
    <>
      {SPACE}
      <TextLink href={first.href} external>
        {consents.readText}
      </TextLink>
    </>
  );

  // El historial de cursos: qué se guarda y para qué, y su casilla al final.
  if (first.explanation !== null) {
    return (
      <ConsentCheckbox
        variant="explained"
        id={boxId(box.name)}
        name={box.name}
        title={first.title}
        description={
          <>
            {first.explanation.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <p>
              {details}
              {read}
            </p>
          </>
        }
        label={t(consents.historyGrant)}
        invalid={invalid}
      />
    );
  }

  return (
    <ConsentCheckbox
      id={boxId(box.name)}
      name={box.name}
      label={
        <>
          {t(consents.accept, { title: first.title })}
          {SPACE}
          {details}
          {read}
        </>
      }
      invalid={invalid}
    />
  );
}

interface FieldsProps {
  view: CompleteView;
  name: string;
  fields: CompleteFields;
  /** Cuenta las revisiones del formulario, las del navegador y las del servidor. */
  round: number;
}

function Fields({ view, name, fields, round }: FieldsProps) {
  return (
    <div className="flex flex-col gap-6">
      <NameField id={NAME_ID} defaultValue={name} problem={fields.name} round={round} />
      <NewPasswordField id={PASSWORD_ID} label={account.fields.password} problem={fields.password} round={round} />
      <ConsentCheckbox id={ADULT_ID} name="adult" label={t(consents.adult, { age: view.minimumAge })} invalid={fields.adult ?? false} />
      {view.boxes.map((box) => (
        <Box key={box.name} box={box} invalid={fields.boxes?.includes(box.name) ?? false} />
      ))}
    </div>
  );
}

function boxMissing(box: ConsentBox): string {
  if (box.kind === "legal") return text.legalMissing;
  if (box.kind === "history") return text.historyMissing;
  return t(consents.textMissing, { title: box.items[0]?.title ?? "" });
}

function summaryOf(view: CompleteView, fields: CompleteFields): FormError[] {
  const errors: FormError[] = [];
  if (fields.name) errors.push({ fieldId: NAME_ID, message: NAME_ERRORS[fields.name] });
  if (fields.password) errors.push({ fieldId: PASSWORD_ID, message: passwordError(fields.password) });
  if (fields.adult) errors.push({ fieldId: ADULT_ID, message: consents.adultMissing });
  for (const box of view.boxes) {
    if (fields.boxes?.includes(box.name)) errors.push({ fieldId: boxId(box.name), message: boxMissing(box) });
  }
  return errors;
}

export interface CompleteScreenProps {
  /** La huella del enlace, tal como llegó en la dirección: la canjea el servicio al enviar. */
  token: string;
  view: CompleteView;
}

export function CompleteScreen({ token, view }: CompleteScreenProps) {
  const [state, action, pending] = useActionState(completeRegistrationAction, IDLE);
  // Lo que el navegador encontró antes de enviar. Mientras exista, nada se manda.
  const [local, checked] = useLocalChecks<CompleteFields>("attempt" in state ? state.attempt : 0);

  if (state.kind === "link_dead") return <RegistrationLinkDeadScreen />;
  if (state.kind === "recover_instead") return <RegistrationUnfinishedScreen />;
  if (state.kind === "texts_unavailable") return <NoCurrentTextScreen withSession={false} />;

  function checkBeforeSending(event: FormEvent<HTMLFormElement>) {
    const fields = checkCompleteForm(view, readCompleteForm(new FormData(event.currentTarget)));
    checked(fields);
    // Con algo que corregir no se envía, así que el formulario no se vacía: lo escrito y lo
    // marcado se quedan.
    if (fields !== null) event.preventDefault();
  }

  const sent = state.kind === "idle" ? 0 : state.attempt;
  // Manda la última revisión: la del navegador, si es más nueva que la respuesta del
  // servidor, y entonces lo que esa respuesta dijo ya no se pinta.
  const fields = local.latest ? (local.found ?? {}) : state.kind === "invalid" ? state.fields : {};
  const name = state.kind === "idle" ? "" : state.name;
  // Lo que dijo el último envío deja de decirse mientras hay otro en camino: si no, al
  // corregir un error del navegador volvería a anunciarse el aviso de antes.
  const answered = local.found === null && !pending;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.title}</h1>
      <form action={action} onSubmit={checkBeforeSending} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={summaryOf(view, fields)} attempt={sent + local.checks} />
        {answered && state.kind === "repainted" && (
          <InlineAlert key={`cambio-${sent}`} tone="warning" live>
            {consents.textsChanged}
          </InlineAlert>
        )}
        {answered && state.kind === "unavailable" && (
          <InlineAlert key={`fallo-${sent}`} tone="danger" live>
            {account.common.unavailable}
          </InlineAlert>
        )}
        <input type="hidden" name="token" value={token} />
        {view.items.map((item) => (
          <input key={item.documentId} type="hidden" name="shown" value={shownValue(item)} />
        ))}
        {/* Cuando cambian los textos, o llega la respuesta de un envío, los campos se arman de nuevo. */}
        <Fields key={`campos-${view.signature}:${sent}`} view={view} name={name} fields={fields} round={sent + local.checks} />
        <Button type="submit" loading={pending} loadingLabel={text.submitting}>
          {text.submit}
        </Button>
      </form>
    </main>
  );
}
