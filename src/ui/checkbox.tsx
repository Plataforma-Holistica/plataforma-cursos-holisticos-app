import { type ReactNode, useId } from "react";

import { describedBy, FieldError } from "./field";

// Casilla (diseño, sección 5.3): para aceptar o para elegir varias. Toda la fila, texto
// incluido, responde al toque, y mide al menos 44 px.

export interface CheckboxProps {
  name: string;
  label: ReactNode;
  value?: string;
  defaultChecked?: boolean;
  id?: string;
  error?: ReactNode;
}

/** La fila de una casilla. La comparten `Checkbox` y `ConsentCheckbox`. */
export function CheckboxRow({
  id,
  name,
  value,
  label,
  defaultChecked,
  required,
  invalid,
  describedById,
}: {
  id: string;
  name: string;
  value?: string;
  label: ReactNode;
  defaultChecked?: boolean;
  required?: boolean;
  invalid: boolean;
  describedById?: string;
}) {
  return (
    <label htmlFor={id} className="flex min-h-touch cursor-pointer items-start gap-3 py-2.5">
      <input
        id={id}
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedById}
        className="mt-0.5 size-5 shrink-0 cursor-pointer accent-accent"
      />
      <span className="text-body text-text">{label}</span>
    </label>
  );
}

export function Checkbox({ name, label, value, defaultChecked, id, error }: CheckboxProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const errorId = `${fieldId}-error`;

  return (
    <div className="flex flex-col gap-1">
      <CheckboxRow
        id={fieldId}
        name={name}
        value={value}
        label={label}
        defaultChecked={defaultChecked}
        invalid={Boolean(error)}
        describedById={describedBy(error ? errorId : undefined)}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
