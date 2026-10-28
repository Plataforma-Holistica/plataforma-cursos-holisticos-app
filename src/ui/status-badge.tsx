import type { ReactNode } from "react";

import { cx } from "./cx";

// Etiqueta de estado (diseño, sección 5): un punto de 8 px y el nombre del estado en estilo `label`.
// El nombre lo da quien la usa, con las palabras de los diagramas de estado del 04; el punto no se
// lee: un estado nunca va solo con su color.

const TONES = {
  /** Borrador, calculada, abierto, sin empezar. */
  neutral: "bg-text-2",
  /** En revisión, procesando, en cierre. */
  active: "bg-accent",
  /** En gracia, acumulada. */
  attention: "bg-warning",
  /** Activa, publicado, pagada, cerrado. */
  good: "bg-success",
  /** Vencida, rechazado, con error. */
  bad: "bg-danger",
} as const;

export type StatusTone = keyof typeof TONES;

export interface StatusBadgeProps {
  tone: StatusTone;
  /** El nombre del estado. */
  children: ReactNode;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span className="inline-flex items-center gap-2 text-label text-text uppercase">
      <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", TONES[tone])} />
      <span>{children}</span>
    </span>
  );
}
