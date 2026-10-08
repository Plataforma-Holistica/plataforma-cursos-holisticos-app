"use client";

import { type MouseEvent, useEffect, useRef } from "react";

import { ui } from "@/messages/es/ui";
import { plural, t } from "@/messages/format";

// Resumen de errores de un formulario (diseño, sección 5.3). Al enviar con errores el foco
// viene aquí, arriba del formulario: dice cuántos datos hay por corregir y enlaza a cada
// campo. Lo escrito no se pierde.

export interface FormError {
  /** El `id` del campo, el mismo que se le dio a su `TextField`. */
  fieldId: string;
  /** Qué pasó y cómo se arregla. El mismo texto que lleva el campo. */
  message: string;
}

export function FormErrorSummary({ errors }: { errors: readonly FormError[] }) {
  const summary = useRef<HTMLDivElement>(null);
  const count = errors.length;

  // Cada vez que llega una tanda nueva de errores.
  useEffect(() => {
    if (count > 0) summary.current?.focus();
  }, [count, errors]);

  if (count === 0) return null;

  // Un enlace a un `id` desplaza la página, pero no en todos los navegadores mueve el foco.
  function focusField(event: MouseEvent<HTMLAnchorElement>, fieldId: string) {
    const field = document.getElementById(fieldId);
    if (!field) return;
    event.preventDefault();
    field.focus();
  }

  return (
    <div
      ref={summary}
      role="alert"
      tabIndex={-1}
      className="flex flex-col gap-2 rounded-md border border-danger bg-danger-bg p-4"
    >
      <p className="text-body font-semibold text-text">{t(plural(count, ui.formErrors), { count })}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {errors.map((error) => (
          <li key={error.fieldId} className="text-body-s text-text">
            <a
              href={`#${error.fieldId}`}
              onClick={(event) => focusField(event, error.fieldId)}
              className="underline underline-offset-4 hover:text-accent-strong"
            >
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
