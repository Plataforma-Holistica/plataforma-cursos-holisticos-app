"use client";

import { useState } from "react";

import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { describedBy, FieldError, FieldHint, FieldLabel, INPUT_CLASSES } from "@/ui/field";

// Un campo de texto del borrador con su contador (diseño, sección 5.3: «18 / 60»; el título del curso
// avisa al acercarse al límite, 03 §4.1). El contador lo pinta el servidor con lo que ya trae, y con
// JavaScript sigue lo que se escribe; el aviso de que quedan pocos se anuncia, el contador no, para no
// hablar con cada tecla. Sin JavaScript el navegador no deja pasar del tope (`maxLength`), y la regla
// del dominio revisa lo demás al enviar.

const AREA_CLASSES =
  "min-h-32 w-full rounded-md border border-border-control bg-surface-2 px-3 py-2 text-body text-text transition-colors duration-(--duration-fast) ease-standard focus-visible:border-focus aria-invalid:border-danger read-only:text-text-2";

export interface CountedFieldProps {
  id: string;
  name: string;
  label: string;
  max: number;
  /** Desde cuántos caracteres se avisa que quedan pocos. */
  warnAt: number;
  defaultValue: string;
  error: string | null;
  optional?: boolean;
  multiline?: boolean;
  readOnly?: boolean;
}

export function CountedField({ id, name, label, max, warnAt, defaultValue, error, optional = false, multiline = false, readOnly = false }: CountedFieldProps) {
  const [count, setCount] = useState([...defaultValue].length);
  const counterId = `${id}-contador`;
  const errorId = `${id}-error`;
  const near = count > warnAt && count <= max;
  const shared = {
    id,
    name,
    defaultValue,
    readOnly,
    maxLength: max,
    "aria-required": optional ? undefined : true,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(counterId, error ? errorId : undefined),
    onInput: (event: { currentTarget: { value: string } }) => setCount([...event.currentTarget.value].length),
  } as const;

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor={id} optional={optional}>
        {label}
      </FieldLabel>
      {multiline ? <textarea {...shared} rows={5} className={AREA_CLASSES} /> : <input {...shared} type="text" autoComplete="off" className={INPUT_CLASSES} />}
      <FieldHint id={counterId}>{t(portal.field.counter, { count, max })}</FieldHint>
      <p aria-live="polite" className="text-caption text-warning">
        {near ? t(portal.field.nearLimit, { count: max - count }) : null}
      </p>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
