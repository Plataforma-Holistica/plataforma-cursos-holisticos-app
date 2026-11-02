"use client";

import { type FormEvent, useActionState, useEffect, useRef, useState } from "react";

import { ThrottledAlert } from "@/app/(cuenta)/_lib/throttled-alert";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { LEGAL_NAME_MAX_LENGTH, TAX_REGIMES, type TaxFormField, type TaxFormProblem } from "@/services/teachers/tax-rules";
import { Button } from "@/ui/button";
import { FormErrorSummary, type FormError } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { PasswordField } from "@/ui/password-field";
import { Select } from "@/ui/select";
import { TextField } from "@/ui/text-field";

import { revealTaxDataAction, saveTaxDataAction } from "./actions";
import type { RevealFailure, RevealState, SaveFailure, SaveState } from "./outcomes";

// PA-48, datos fiscales y bancarios (T-409; FL-31). Dos bloques, cada uno con su acción y su estado, que no se juntan: con lo oculto a la vista no se
// pinta ningún formulario ligado a esa acción, porque sin JavaScript React mandaría el estado dentro de él. «Ocultar» y «Cambiar» son enlaces de carga
// completa: el estado no sobrevive. Con JavaScript, lo escrito se queda en el navegador: ninguna respuesta lo trae, y sin él se vuelve a escribir.

const text = portal.taxData;
const REVEAL_IDLE: RevealState = { kind: "idle" };
const SAVE_IDLE: SaveState = { kind: "idle" };
const REVEAL_PASSWORD_ID = "fiscal-ver-contrasena";
const SAVE_PASSWORD_ID = "fiscal-guardar-contrasena";
const CHANGE_PATH = `${ROUTES.portalTaxData}?cambiar=1`;
const FIELD_IDS: Record<TaxFormField, string> = { rfc: "fiscal-rfc", regime: "fiscal-regimen", legalName: "fiscal-razon-social", clabe: "fiscal-clabe" };
const REGIME_OPTIONS = TAX_REGIMES.map(({ code }) => ({ value: code, label: t(text.fields.regimeOption, { code, name: text.regimes[code] }) }));

function regimeLabel(code: string): string {
  return code in text.regimes ? text.regimes[code as keyof typeof text.regimes] : code;
}

function problemText(field: TaxFormField, problem: TaxFormProblem): string {
  if (field === "legalName" && problem === "long") return t(text.problems.legalName.long, { max: LEGAL_NAME_MAX_LENGTH });
  if (problem === "check_digit") return text.problems.clabe.checkDigit;
  const words = text.problems[field] as Readonly<Partial<Record<TaxFormProblem, string>>>;
  return words[problem] ?? text.failed.unavailable;
}

/** Lo que se dice en el bloque. La contraseña equivocada no está aquí: se dice en su campo. */
const FAILED: Record<Exclude<RevealFailure | SaveFailure, "wrong_password">, string> = {
  capped: text.failed.capped,
  unavailable: text.failed.unavailable,
  off: text.failed.off,
  no_profile: text.failed.noProfile,
};

/**
 * Lo mostrado. El botón pulsado desaparece con el formulario y el foco cae al documento: lo toma el título, para que un lector de pantalla se entere. A
 * quien se fue a otra cosa mientras esperaba no se lo quita.
 */
function Revealed({ data, canChange }: { data: Extract<RevealState, { kind: "revealed" }>["data"]; canChange: boolean }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) title.current?.focus();
  }, []);
  return (
    <section className="flex flex-col gap-6">
      <h2 ref={title} tabIndex={-1} className="text-h3">
        {text.reveal.title}
      </h2>
      <dl className="flex flex-col gap-3">
        {[
          [text.fields.rfc, data.rfc],
          [text.fields.regime, regimeLabel(data.regime)],
          [text.fields.legalName, data.legalName],
          [text.fields.clabe, data.clabe],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="text-body-s text-text-2">{label}</dt>
            <dd className="break-words text-body">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-small text-text-2">{t(text.lastChange, { date: data.date })}</p>
      <p className="flex flex-wrap gap-4">
        {/* Enlaces de verdad, sin el enrutador: con una carga completa no queda nada de esta respuesta. */}
        <a href={ROUTES.portalTaxData} className="underline">
          {text.reveal.hide}
        </a>
        {canChange && (
          <a href={CHANGE_PATH} className="underline">
            {text.change}
          </a>
        )}
      </p>
    </section>
  );
}

export function TaxReveal({ canChange }: { canChange: boolean }) {
  const [state, action, pending] = useActionState(revealTaxDataAction, REVEAL_IDLE, ROUTES.portalTaxData);

  if (state.kind === "revealed") return <Revealed data={state.data} canChange={canChange} />;

  const failure = state.kind === "failed" && state.reason !== "wrong_password" ? state.reason : null;
  const wrong = state.kind === "failed" && state.reason === "wrong_password";
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  return (
    <form action={action} noValidate className="flex flex-col gap-6">
      <p className="text-text-2">{text.reveal.intro}</p>
      <FormErrorSummary errors={wrong ? [{ fieldId: REVEAL_PASSWORD_ID, message: text.problems.password }] : []} attempt={attempt} />
      {state.kind === "throttled" && <ThrottledAlert key={attempt} retryAt={state.retryAt} />}
      {failure !== null && (
        <InlineAlert key={attempt} tone={failure === "no_profile" ? "warning" : "danger"} live>
          {FAILED[failure]}
        </InlineAlert>
      )}
      <PasswordField key={`password-${attempt}`} id={REVEAL_PASSWORD_ID} label={text.password} name="password" autoComplete="current-password" error={wrong ? text.problems.password : undefined} />
      <p className="flex flex-wrap items-center gap-4">
        <Button type="submit" loading={pending} loadingLabel={text.reveal.submitting}>
          {text.reveal.submit}
        </Button>
        {canChange && (
          <a href={CHANGE_PATH} className="underline">
            {text.change}
          </a>
        )}
      </p>
    </form>
  );
}

const NO_DRAFT = { rfc: "", regime: "", legal_name: "", clabe: "" };
type Draft = typeof NO_DRAFT;

export function TaxCapture({ seen, changing, email = null }: { seen: number; changing: boolean; email?: string | null }) {
  // Sin JavaScript se vuelve a esta dirección: sin `cambiar`, la pantalla pintaría el otro bloque, y el error no tendría quién lo dijera.
  const [state, action, pending] = useActionState(saveTaxDataAction, SAVE_IDLE, changing ? CHANGE_PATH : ROUTES.portalTaxData);
  // Lo escrito, en el navegador: React devuelve el formulario a sus valores por omisión al terminar la acción, y aquí ninguna respuesta lo trae.
  const [draft, setDraft] = useState<Draft>(NO_DRAFT);
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const problems = state.kind === "invalid" ? state.problems : {};
  const failure = state.kind === "failed" && state.reason !== "wrong_password" ? state.reason : null;
  const wrong = state.kind === "failed" && state.reason === "wrong_password";
  const message = (field: TaxFormField): string | undefined => {
    const problem = problems[field];
    return problem === undefined ? undefined : problemText(field, problem);
  };
  const errors: FormError[] = (Object.keys(FIELD_IDS) as TaxFormField[]).flatMap((field) => {
    const said = message(field);
    return said === undefined ? [] : [{ fieldId: FIELD_IDS[field], message: said }];
  });
  if (wrong) errors.push({ fieldId: SAVE_PASSWORD_ID, message: text.problems.password });

  const remember = (event: FormEvent<HTMLFormElement>) => {
    const { name, value } = event.target as HTMLInputElement;
    if (name in NO_DRAFT) setDraft((before) => ({ ...before, [name]: value }));
  };

  return (
    <form action={action} onChange={remember} noValidate autoComplete="off" className="flex flex-col gap-6">
      <p className="text-text-2">{text.capture.intro}</p>
      <InlineAlert tone="warning">{text.capture.clabeWait}</InlineAlert>
      <FormErrorSummary errors={errors} attempt={attempt} />
      {state.kind === "throttled" && <ThrottledAlert key={attempt} retryAt={state.retryAt} />}
      {failure !== null && (
        <InlineAlert key={attempt} tone="danger" live>
          {FAILED[failure]}
        </InlineAlert>
      )}
      <input type="hidden" name="seen" value={seen} />
      {/* Para el gestor de contraseñas: sin un usuario, tomaría como tal el texto anterior a la contraseña, que aquí es la CLABE. No se lee. */}
      {email !== null && <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />}
      <TextField id={FIELD_IDS.rfc} label={text.fields.rfc} name="rfc" autoComplete="off" defaultValue={draft.rfc} error={message("rfc")} />
      {/* Con su llave: una lista no toma otro valor por omisión después de montarse, y sin esto volvería a «Elige». */}
      <Select key={`regime-${attempt}`} id={FIELD_IDS.regime} label={text.fields.regime} name="regime" options={REGIME_OPTIONS} prompt={text.fields.regimePrompt} defaultValue={draft.regime} error={message("regime")} />
      <TextField id={FIELD_IDS.legalName} label={text.fields.legalName} name="legal_name" autoComplete="off" hint={text.fields.legalNameHint} defaultValue={draft.legal_name} error={message("legalName")} />
      <TextField id={FIELD_IDS.clabe} label={text.fields.clabe} name="clabe" autoComplete="off" inputMode="numeric" hint={text.fields.clabeHint} defaultValue={draft.clabe} error={message("clabe")} />
      <PasswordField key={`password-${attempt}`} id={SAVE_PASSWORD_ID} label={text.password} name="password" autoComplete="current-password" hint={text.capture.passwordHint} error={wrong ? text.problems.password : undefined} />
      <p className="flex flex-wrap items-center gap-4">
        <Button type="submit" loading={pending} loadingLabel={text.capture.submitting}>
          {text.capture.submit}
        </Button>
        {changing && (
          <a href={ROUTES.portalTaxData} className="underline">
            {text.capture.cancel}
          </a>
        )}
      </p>
    </form>
  );
}
