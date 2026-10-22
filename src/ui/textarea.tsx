import { type ReactNode, useId } from "react";

import { describedBy, FieldError, FieldHint, FieldLabel } from "./field";

// Área de texto (diseño, sección 5.3): como el campo de texto, para lo que se escribe en varias
// líneas (una nota, una evidencia, un motivo). Enter escribe un salto de línea y no envía. Sin
// contador todavía: la variante con contador llega con la primera pantalla que la pida.

/** Como el campo de texto, sin su alto fijo: crece con `rows` y se puede estirar hacia abajo. */
const AREA_CLASSES =
  "w-full resize-y rounded-md border border-border-control bg-surface-2 px-3 py-3 text-body text-text transition-colors duration-(--duration-fast) ease-standard focus-visible:border-focus aria-invalid:border-danger read-only:text-text-2";

export interface TextareaProps {
  label: ReactNode;
  name: string;
  /** Para que el resumen de errores, o quien devuelve el foco, pueda llegar a esta área. */
  id?: string;
  hint?: ReactNode;
  /** Qué pasó y cómo se arregla. Con esto el área queda marcada. */
  error?: ReactNode;
  /** Lo obligatorio es la norma. Lo opcional lo dice. */
  optional?: boolean;
  /** Lo que la persona ya había escrito: no se pierde al volver con errores. */
  defaultValue?: string;
  rows?: number;
  readOnly?: boolean;
}

export function Textarea({ label, name, id, hint, error, optional = false, defaultValue, rows = 4, readOnly }: TextareaProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor={fieldId} optional={optional}>
        {label}
      </FieldLabel>
      <textarea
        id={fieldId}
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        readOnly={readOnly}
        aria-required={optional ? undefined : true}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint ? hintId : undefined, error ? errorId : undefined)}
        className={AREA_CLASSES}
      />
      {hint && <FieldHint id={hintId}>{hint}</FieldHint>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
