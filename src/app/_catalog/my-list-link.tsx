"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import { MY_LIST_ARRIVAL } from "./my-list/arrival";

// «Mi lista» de la barra del alumno (T-616, solicitud 2): un enlace del enrutador al bloque del inicio que, al
// pulsarlo, se lo avisa al bloque (`MY_LIST_ARRIVAL`). Sin JavaScript es un enlace como cualquiera, y el bloque queda
// como `:target`.
//
// Desde la 3b-1, el clic deja además una marca de un solo uso (`takeArrival`): si el inicio todavía no está pintado (se
// pulsó desde la cuenta, por ejemplo), el bloque la consume al montarse y toma el foco. Antes el bloque miraba solo la
// dirección, y lo tomaba también al recargar con el ancla, sin que nadie llegara por la barra. La marca vive en este
// módulo, en la memoria de la pestaña: se pierde al recargar, que es justo lo que se quiere, y no se comparte entre
// pestañas (decisión mía sin confirmar; con `sessionStorage` sobreviviría a la recarga). Va en el `.tsx` y no en
// `arrival.ts`, que tiene dueño.
//
// Con una tecla de modificación o con otro botón, el navegador abre otra pestaña o ventana y esta no navega: ni aviso ni
// marca, que se quedaría viva para el próximo inicio que se monte.

let arrived = false;

/** Si se llegó por «Mi lista» y nadie lo ha usado todavía. La marca se usa una sola vez. */
export function takeArrival(): boolean {
  const was = arrived;
  arrived = false;
  return was;
}

/** Si el clic navega en esta misma pestaña, como lo decide `next/link`. */
function inThisTab(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function MyListLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={className}
      onClick={(event) => {
        if (!inThisTab(event)) return;
        arrived = true;
        window.dispatchEvent(new Event(MY_LIST_ARRIVAL));
      }}
    >
      {children}
    </Link>
  );
}
