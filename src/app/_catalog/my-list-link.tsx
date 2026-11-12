"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { MY_LIST_ARRIVAL } from "./my-list/arrival";

// «Mi lista» de la barra del alumno (T-616, solicitud 2): un enlace del enrutador al bloque del inicio que, al
// pulsarlo, se lo avisa al bloque (`MY_LIST_ARRIVAL`). Si el inicio todavía no está pintado, el bloque lo ve en la
// dirección al montarse. Sin JavaScript es un enlace como cualquiera, y el bloque queda como `:target`.

export function MyListLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <Link href={href} className={className} onClick={() => window.dispatchEvent(new Event(MY_LIST_ARRIVAL))}>
      {children}
    </Link>
  );
}
