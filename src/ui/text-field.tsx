import { type HTMLInputAutoCompleteAttribute, type ReactNode, useId } from "react";

import { describedBy, FieldError, FieldHint, FieldLabel, INPUT_CLASSES } from "./field";

// Campo de texto (diseño, sección 5.3). La validación ocurre al salir del campo y al
// enviar, nunca mientras se escribe: la hace quien arma el formulario, y aquí llega el
// resultado en `error`.

export interface TextFieldProps {
  label: ReactNode;
  name: string;
  /** Obligatorio: así el navegador y los gestores de contraseñas pueden llenarlo. */
  autoComplete: HTMLInputAutoCompleteAttribute;
  type?: "text" | "email" | "tel" | "url" | "search";
  inputMode?: "text" | "email" | "tel" | "url" | "numeric" | "decimal" | "search";
  /** Para que el resumen de errores pueda enlazar a este campo. */
  id?: string;
  hint?: ReactNode;
  /** Qué pasó y cómo se arregla. Con esto el campo queda marcado. */
  error?: ReactNode;
  /** Lo obligatorio es la norma. Lo opcional lo dice. */
  optional?: boolean;
  /** Lo que la persona ya había escrito: no se pierde al volver con errores. */
  defaultValue?: string;
  readOnly?: boolean;
}

export function TextField({
  label,
  name,
  autoComplete,
  type = "text",
  inputMode,
  id,
  hint,
  error,
  optional = false,
  defaultValue,
  readOnly,
}: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor={fieldId} optional={optional}>
        {label}
      </FieldLabel>
      <input
        id={fieldId}
        name={name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        readOnly={readOnly}
        aria-required={optional ? undefined : true}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint ? hintId : undefined, error ? errorId : undefined)}
        className={INPUT_CLASSES}
      />
      {hint && <FieldHint id={hintId}>{hint}</FieldHint>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
