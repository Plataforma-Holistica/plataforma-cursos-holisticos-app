import { type ReactNode, useId } from "react";

import { describedBy, FieldError, FieldHint, FieldLabel, INPUT_CLASSES } from "./field";

// Lista de selección (diseño, sección 5.3): la nativa del navegador, que en el teléfono es la del
// sistema. La lista propia con búsqueda (más de 12 opciones) llega con la primera pantalla que la
// pida. Ninguna opción viene elegida: la primera es la que pide elegir, sin valor, y no se puede
// volver a elegir.

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: ReactNode;
  name: string;
  options: readonly SelectOption[];
  /** Lo que dice la lista antes de elegir: «Elige uno». */
  prompt: string;
  id?: string;
  hint?: ReactNode;
  /** Qué pasó y cómo se arregla. Con esto la lista queda marcada. */
  error?: ReactNode;
  optional?: boolean;
  /** Lo que la persona ya había elegido: no se pierde al volver con errores. */
  defaultValue?: string;
}

export function Select({ label, name, options, prompt, id, hint, error, optional = false, defaultValue }: SelectProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  // Lo elegido antes, solo si sigue siendo una de las opciones.
  const chosen = options.some((option) => option.value === defaultValue) ? defaultValue : "";

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor={fieldId} optional={optional}>
        {label}
      </FieldLabel>
      <select
        id={fieldId}
        name={name}
        defaultValue={chosen}
        aria-required={optional ? undefined : true}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint ? hintId : undefined, error ? errorId : undefined)}
        className={INPUT_CLASSES}
      >
        <option value="" disabled>
          {prompt}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <FieldHint id={hintId}>{hint}</FieldHint>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
