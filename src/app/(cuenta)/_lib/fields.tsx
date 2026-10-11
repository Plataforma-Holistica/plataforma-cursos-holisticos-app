"use client";

import { type FocusEvent, type FormEvent, type ReactNode, useState } from "react";
import { Check, Circle } from "lucide";

import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { checkPassword, parseDisplayName, parseEmail, PASSWORD_MIN_LENGTH } from "@/services/account/field-rules";
import { cx, SPACE } from "@/ui/cx";
import { Icon } from "@/ui/icon";
import { PasswordField } from "@/ui/password-field";
import { TextField } from "@/ui/text-field";

import { useSeenOnBlur } from "./hooks";

// Los campos que se repiten entre las pantallas de la cuenta: el nombre, el correo al que
// se manda un enlace y la contraseña nueva. Los tres validan al salir del campo, y solo si
// ya traen algo (diseño, sección 5.5): un campo vacío se marca al enviar. Las reglas son las
// mismas del dominio que usa el servidor, que es el que manda.
//
// Lo que se ve al salir del campo se pinta cuando termina el clic o la tecla que sacó el
// foco, y vale mientras no llegue una revisión más nueva del formulario (`useSeenOnBlur`).

export type NameProblem = "empty" | "too_long" | "invalid";
export type EmailProblem = "required" | "invalid";
export type PasswordProblem = "too_short" | "too_long" | "malformed";

export const NAME_ERRORS = {
  empty: account.fields.nameRequired,
  too_long: account.fields.nameTooLong,
  invalid: account.fields.nameInvalid,
} as const;

export const EMAIL_ERRORS = { required: account.fields.emailRequired, invalid: account.fields.emailInvalid } as const;

/** El mensaje de una contraseña nueva que no cumple la regla. */
export function passwordError(problem: PasswordProblem): string {
  if (problem === "too_short") return t(account.fields.passwordTooShort, { min: PASSWORD_MIN_LENGTH });
  return problem === "too_long" ? account.fields.passwordTooLong : account.fields.passwordInvalid;
}

interface CheckedField<Problem> {
  id: string;
  /** Lo que dijo la última revisión del formulario, al enviar o antes de enviar. */
  problem?: Problem | undefined;
  /** Cuenta las revisiones del formulario: con una nueva, lo visto al salir del campo ya no manda. */
  round?: number;
}

export interface NameFieldProps extends CheckedField<NameProblem> {
  /** Lo escrito en el envío anterior: React vacía el formulario después de su acción. */
  defaultValue: string;
}

/** El nombre de la persona (RF-109). */
export function NameField({ id, defaultValue, problem, round = 0 }: NameFieldProps) {
  const [shown, see] = useSeenOnBlur(problem, round);

  function validate(event: FocusEvent<HTMLDivElement>) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.name !== "name") return;
    const parsed = parseDisplayName(field.value);
    see(field.value.trim() === "" ? undefined : parsed.ok ? null : parsed.reason);
  }

  return (
    <div onBlur={validate}>
      <TextField
        id={id}
        label={account.fields.name}
        name="name"
        autoComplete="name"
        defaultValue={defaultValue}
        error={shown ? NAME_ERRORS[shown] : undefined}
      />
    </div>
  );
}

export interface EmailFieldProps extends CheckedField<EmailProblem> {
  /** Lo escrito en el envío anterior. */
  defaultValue: string;
  hint?: ReactNode;
}

/** El correo al que se manda un enlace. */
export function EmailField({ id, defaultValue, problem, round = 0, hint }: EmailFieldProps) {
  const [shown, see] = useSeenOnBlur(problem, round);

  function validate(event: FocusEvent<HTMLDivElement>) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.name !== "email") return;
    see(field.value.trim() === "" ? undefined : parseEmail(field.value).ok ? null : "invalid");
  }

  return (
    <div onBlur={validate}>
      <TextField
        id={id}
        label={account.fields.email}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        defaultValue={defaultValue}
        hint={hint}
        error={shown ? EMAIL_ERRORS[shown] : undefined}
      />
    </div>
  );
}

export interface NewPasswordFieldProps extends CheckedField<PasswordProblem> {
  label: string;
}

/**
 * Una contraseña nueva, con su regla a la vista desde antes de escribir y marcada al
 * cumplirse (diseño, PA-13 y PA-14). Sin JavaScript la regla se queda sin marcar: la revisa
 * el servidor al enviar. La contraseña nunca vuelve en una respuesta: el campo llega vacío.
 */
export function NewPasswordField({ id, label, problem, round = 0 }: NewPasswordFieldProps) {
  const [met, setMet] = useState(false);
  const [shown, see] = useSeenOnBlur(problem, round);

  function track(event: FormEvent<HTMLDivElement>) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.name !== "password") return;
    const checked = checkPassword(field.value);
    // La regla que se pinta es la del mínimo: las otras dos tienen su propio mensaje.
    setMet(checked.ok || checked.reason !== "too_short");
  }

  function validate(event: FocusEvent<HTMLDivElement>) {
    const wrapper = event.currentTarget;
    // «Mostrar» es parte del campo: ir a ese botón no es salir, y una contraseña a medio
    // escribir no se marca por querer verla.
    if (event.relatedTarget instanceof Node && wrapper.contains(event.relatedTarget)) return;
    const field = wrapper.querySelector<HTMLInputElement>('input[name="password"]');
    if (field === null) return;
    const checked = checkPassword(field.value);
    see(field.value === "" ? undefined : checked.ok ? null : checked.reason);
  }

  return (
    <div onInput={track} onBlur={validate}>
      <PasswordField
        id={id}
        label={label}
        name="password"
        autoComplete="new-password"
        rules={
          <p className={cx("flex items-center gap-2", met && "text-success")}>
            <Icon icon={met ? Check : Circle} size={16} />
            <span>
              {met && (
                <>
                  <span className="sr-only">{account.fields.passwordRuleMet}</span>
                  {SPACE}
                </>
              )}
              {t(account.fields.passwordRule, { min: PASSWORD_MIN_LENGTH })}
            </span>
          </p>
        }
        error={shown ? passwordError(shown) : undefined}
      />
    </div>
  );
}
