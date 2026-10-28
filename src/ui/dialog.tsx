"use client";

import { TriangleAlert } from "lucide";
import { type ReactNode, useEffect, useId, useRef } from "react";

import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { Icon } from "./icon";

// Diálogo (diseño, sección 5): pedir una confirmación sin cambiar de pantalla. Título que dice la
// acción, una o dos frases con las consecuencias, y los botones: cancelar primero, y el que confirma
// repite el verbo del título. El irreversible (cerrar un periodo) lo dice también con palabras.
//
// Lo pinta el servidor cuando la pantalla está preguntando, así que funciona sin JavaScript: entonces
// es un `<dialog open>` en su lugar. Con JavaScript se vuelve modal (`showModal`): el foco entra, no sale
// mientras está abierto, y Escape pulsa el botón de cancelar, salvo a media operación. Los botones los
// da quien lo usa, dentro de su formulario: cancelar también es un envío. Al irse, el foco vuelve a
// donde estaba si sigue en la página y nadie más lo tomó.

export interface DialogProps {
  title: string;
  /** Las consecuencias. */
  children: ReactNode;
  /** El botón de cancelar: va primero, y es el que pulsa Escape. */
  cancel: ReactNode;
  /** El botón que confirma: repite el verbo del título. */
  confirm: ReactNode;
  /** Lo que se confirma no se puede deshacer. */
  irreversible?: boolean;
  /** Va en camino lo que se confirmó: Escape no cancela. */
  busy?: boolean;
  /** Lo que va entre las consecuencias y los botones (la casilla «Entiendo que no se puede deshacer»). */
  extra?: ReactNode;
}

export function Dialog({ title, children, cancel, confirm, irreversible = false, busy = false, extra }: DialogProps) {
  const box = useRef<HTMLDialogElement>(null);
  const cancelBox = useRef<HTMLSpanElement>(null);
  const busyNow = useRef(busy);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    busyNow.current = busy;
  }, [busy]);

  useEffect(() => {
    const dialog = box.current;
    if (dialog === null) return;
    const before = document.activeElement;
    // El DOM de las pruebas no tiene `showModal`: ahí se queda en su lugar, como sin JavaScript.
    if (typeof dialog.showModal === "function") {
      dialog.close();
      dialog.showModal();
    }
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (busyNow.current) return;
      cancelBox.current?.querySelector<HTMLElement>("button, a")?.click();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (lost && before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  return (
    <dialog
      ref={box}
      open
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="m-auto w-full max-w-form rounded-md border border-border bg-surface-1 p-6 text-text shadow-overlay backdrop:bg-scrim max-sm:mb-0 max-sm:max-w-none max-sm:rounded-b-none"
    >
      <div className="flex flex-col gap-4">
        {irreversible && (
          <p className="flex items-center gap-2 text-label text-danger uppercase">
            <Icon icon={TriangleAlert} size={16} />
            {ui.dialog.irreversible}
          </p>
        )}
        <h2 id={titleId} className="text-h3">
          {title}
        </h2>
        <div id={bodyId} className="flex flex-col gap-2 text-body text-text-2">
          {children}
        </div>
        {extra}
        <div className={cx("flex flex-wrap justify-between gap-3")}>
          <span ref={cancelBox} className="contents">
            {cancel}
          </span>
          {confirm}
        </div>
      </div>
    </dialog>
  );
}
