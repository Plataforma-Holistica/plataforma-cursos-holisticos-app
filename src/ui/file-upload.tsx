"use client";

import { type DragEvent, useId, useRef, useState } from "react";

import { cx } from "./cx";

// Subida de archivo (`FileUpload`, diseño, sección 5.5): dónde se elige o se suelta un archivo. Lo que pasa con el archivo es de quien
// lo usa. Además de arrastrar siempre está el control nativo con su botón (WCAG 2.5.7), que es lo que usa quien no arrastra. Se vacía
// después de cada elección: elegir el mismo archivo otra vez, para reanudar, tiene que volver a avisar.
//
// Por ahora lo usa el video (T-403). El selector de los recursos sigue en su formulario, porque ahí el archivo se elige y se sube
// después con su título.

export interface FileUploadProps {
  label: string;
  hint: string;
  /** Lo que se admite, como `accept`: `.mp4,.mov`. Es comodidad: quien lo usa revisa lo que llega. */
  accept: string;
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function FileUpload({ label, hint, accept, onFile, disabled = false }: FileUploadProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (!disabled && file !== undefined) onFile(file);
  }

  return (
    <div
      data-testid="file-upload"
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx("flex flex-col gap-2 rounded-md border border-dashed p-4", over ? "border-accent bg-accent-subtle" : "border-border")}
    >
      <label htmlFor={id} className="text-label">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        aria-describedby={`${id}-nota`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) onFile(file);
          if (input.current !== null) input.current.value = "";
        }}
        className="min-h-touch text-body-s text-text-2"
      />
      <p id={`${id}-nota`} className="text-caption text-text-3">
        {hint}
      </p>
    </div>
  );
}
