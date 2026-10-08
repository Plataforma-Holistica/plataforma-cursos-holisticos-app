"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { describedBy, FieldError, FieldHint, FieldLabel, INPUT_CLASSES } from "./field";

// Campo de contraseña (diseño, sección 5.3). Lleva un botón para mostrarla u ocultarla.
// Nunca bloquea el pegado ni el llenado automático (WCAG 3.3.8): no hay un solo manejador
// sobre el campo. Lo único que escucha es el envío de su formulario, para volver a
// ocultarla: enviada a la vista, el navegador la trataría como un texto cualquiera.
//
// Las reglas de una contraseña nueva no viven aquí: cuáles son lo decide el TRD, y la
// pantalla las pasa ya armadas en `rules`, a la vista desde antes de escribir.

export interface PasswordFieldProps {
  label: ReactNode;
  name: string;
  /** `current-password` al entrar, `new-password` al crearla o cambiarla. */
  autoComplete: "current-password" | "new-password";
  id?: string;
  hint?: ReactNode;
  /** Las reglas de una contraseña nueva, cada una marcada al cumplirse. */
  rules?: ReactNode;
  error?: ReactNode;
}

export function PasswordField({ label, name, autoComplete, id, hint, rules, error }: PasswordFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const rulesId = `${fieldId}-rules`;
  const errorId = `${fieldId}-error`;
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Antes de que el formulario salga, el campo vuelve a ser de contraseña: así no acaba
  // en el historial de formularios y el gestor de contraseñas ofrece guardarla.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const hide = () => setVisible(false);
    form.addEventListener("submit", hide, { capture: true });
    return () => form.removeEventListener("submit", hide, { capture: true });
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
      <div className="relative">
        <input
          ref={input}
          id={fieldId}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          aria-required
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint ? hintId : undefined, rules ? rulesId : undefined, error ? errorId : undefined)}
          // Lugar para el botón, que va encima del campo.
          className={cx(INPUT_CLASSES, "pr-24")}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? ui.password.hideLabel : ui.password.showLabel}
          aria-controls={fieldId}
          className="absolute inset-y-0 right-0 min-w-touch cursor-pointer rounded-md px-3 text-body-s font-semibold text-accent halo-surface-2 hover:text-accent-strong"
        >
          {visible ? ui.password.hide : ui.password.show}
        </button>
      </div>
      {hint && <FieldHint id={hintId}>{hint}</FieldHint>}
      {rules && (
        <div id={rulesId} className="text-caption text-text-2">
          {rules}
        </div>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
