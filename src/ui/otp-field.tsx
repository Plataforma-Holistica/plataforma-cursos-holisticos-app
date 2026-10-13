import type { ReactNode } from "react";

import { TextField } from "./text-field";

// Campo de código (diseño, sección 5.3), para el segundo factor. Un solo campo de texto, no
// seis cajitas: así se puede pegar el código completo y el navegador puede llenarlo (WCAG
// 3.3.8).
//
// No lleva tope de largo ni patrón: las aplicaciones muestran el código partido en dos
// («123 456»), y un tope cortaría lo pegado. Qué es un código lo decide la regla del
// dominio, al salir del campo y en el servidor. Tampoco recibe un valor: un código no se
// devuelve a la pantalla.

export interface OTPFieldProps {
  label: ReactNode;
  name: string;
  /** Para que el resumen de errores pueda enlazar a este campo. */
  id?: string;
  hint?: ReactNode;
  /** Qué pasó y cómo se arregla. Con esto el campo queda marcado. */
  error?: ReactNode;
  readOnly?: boolean;
}

export function OTPField({ label, name, id, hint, error, readOnly }: OTPFieldProps) {
  return (
    <TextField label={label} name={name} id={id} hint={hint} error={error} readOnly={readOnly} type="text" inputMode="numeric" autoComplete="one-time-code" />
  );
}
