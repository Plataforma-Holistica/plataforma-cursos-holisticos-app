"use client";

import { type FocusEvent, type FormEvent, type ReactNode, useState } from "react";
import { Check, Circle } from "lucide";

import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import { checkPassword, parseEmail, PASSWORD_MIN_LENGTH } from "@/services/account/field-rules";
import { cx, SPACE } from "@/ui/cx";
import { Icon } from "@/ui/icon";
import { PasswordField } from "@/ui/password-field";
import { TextField } from "@/ui/text-field";

// Los dos campos que se repiten entre las pantallas de la cuenta: el correo con el que se
// pide un enlace y la contraseña nueva. Los dos validan al salir del campo, y solo si ya
// traen algo (diseño, sección 5.5): un campo vacío se marca al enviar. Las reglas son las
// mismas del dominio que usa el servidor, que es el que manda.
//
// Quien los usa los arma de nuevo (con `key`) cuando llega la respuesta de un envío: así lo
// que se vio al salir del campo no tapa lo que dijo el servidor.

export type EmailProblem = "required" | "invalid";
export type PasswordProblem = "too_short" | "too_long" | "malformed";

export const EMAIL_ERRORS = { required: account.fields.emailRequired, invalid: account.fields.emailInvalid } as const;

/** El mensaje de una contraseña nueva que no cumple la regla. */
export function passwordError(problem: PasswordProblem): string {
  if (problem === "too_short") return t(account.fields.passwordTooShort, { min: PASSWORD_MIN_LENGTH });
  return problem === "too_long" ? account.fields.passwordTooLong : account.fields.passwordInvalid;
}

export interface EmailFieldProps {
  id: string;
  /** Lo escrito en el envío anterior: React vacía el formulario después de su acción. */
  defaultValue: string;
  /** Lo que dijo el último envío. */
  problem?: EmailProblem | undefined;
  hint?: ReactNode;
}

/** El correo al que se manda un enlace. */
export function EmailField({ id, defaultValue, problem, hint }: EmailFieldProps) {
  // Lo que se vio al salir del campo manda sobre lo que dijo el último envío.
  const [onBlur, setOnBlur] = useState<EmailProblem | null | undefined>(undefined);
  const shown = onBlur === undefined ? problem : (onBlur ?? undefined);

  function validate(event: FocusEvent<HTMLDivElement>) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.name !== "email") return;
    // Vacío, vuelve a mandar lo que dijo el último envío.
    if (field.value.trim() === "") return setOnBlur(undefined);
    setOnBlur(parseEmail(field.value).ok ? null : "invalid");
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

export interface NewPasswordFieldProps {
  id: string;
  label: string;
  /** Lo que dijo el último envío. */
  problem?: PasswordProblem | undefined;
}

/**
 * Una contraseña nueva, con su regla a la vista desde antes de escribir y marcada al
 * cumplirse (diseño, PA-13 y PA-14). Sin JavaScript la regla se queda sin marcar: la revisa
 * el servidor al enviar. La contraseña nunca vuelve en una respuesta: el campo llega vacío.
 */
export function NewPasswordField({ id, label, problem }: NewPasswordFieldProps) {
  const [met, setMet] = useState(false);
  const [onBlur, setOnBlur] = useState<PasswordProblem | null | undefined>(undefined);
  const shown = onBlur === undefined ? problem : (onBlur ?? undefined);

  const passwordOf = (target: EventTarget): string | null =>
    target instanceof HTMLInputElement && target.name === "password" ? target.value : null;

  function track(event: FormEvent<HTMLDivElement>) {
    const value = passwordOf(event.target);
    if (value === null) return;
    const checked = checkPassword(value);
    // La regla que se pinta es la del mínimo: las otras dos tienen su propio mensaje.
    setMet(checked.ok || checked.reason !== "too_short");
  }

  function validate(event: FocusEvent<HTMLDivElement>) {
    const value = passwordOf(event.target);
    if (value === null) return;
    // Vacío, vuelve a mandar lo que dijo el último envío.
    if (value === "") return setOnBlur(undefined);
    const checked = checkPassword(value);
    setOnBlur(checked.ok ? null : checked.reason);
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
