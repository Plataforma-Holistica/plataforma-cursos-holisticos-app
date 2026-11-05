"use client";

import { type ChangeEvent, type InputHTMLAttributes, type Ref, useState } from "react";

import { ui } from "@/messages/es/ui";

import { cx } from "./cx";

// El selector de archivo en español (T-614). El botón del control nativo lo escribe el navegador en su
// idioma («Choose File»), y no hay CSS que cambie ese texto. El control se queda, fuera de la vista
// (`sr-only`): es el que recibe el foco y el teclado, y el que lee el lector de pantalla con el nombre del
// campo (`labelId`). Lo que se ve es una etiqueta del control con forma de botón, que lo abre al pulsarla,
// y el nombre de lo elegido; las dos van ocultas al lector, que ya lee el control.
//
// El anillo de foco del control lo pinta el botón visible (`peer-focus-visible`), igual que el global.
// Si quien lo usa vacía el control por código, el nombre no se entera: que lo vuelva a montar con otra
// `key`.

export interface FileInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "id" | "aria-labelledby"> {
  id: string;
  /** El `id` de la etiqueta del campo: es el nombre del control para el lector de pantalla. */
  labelId: string;
  ref?: Ref<HTMLInputElement>;
}

const BUTTON =
  "inline-grid min-h-touch cursor-pointer place-items-center rounded-md border border-border-control px-4 text-body font-semibold text-text transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-2 active:bg-surface-1";
const FOCUS =
  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:shadow-focus";
const DISABLED =
  "peer-disabled:cursor-not-allowed peer-disabled:border-transparent peer-disabled:bg-surface-2 peer-disabled:text-text-disabled";

export function FileInput({ id, labelId, onChange, ref, ...props }: FileInputProps) {
  const [name, setName] = useState("");

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    setName(event.target.files?.[0]?.name ?? "");
    onChange?.(event);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <input {...props} ref={ref} id={id} type="file" aria-labelledby={labelId} onChange={onPick} className="peer sr-only" />
      <label htmlFor={id} aria-hidden="true" className={cx(BUTTON, FOCUS, DISABLED)}>
        {ui.fileInput.choose}
      </label>
      <span aria-hidden="true" className="min-w-0 text-body-s break-all text-text-2">
        {name === "" ? ui.fileInput.none : name}
      </span>
    </div>
  );
}
