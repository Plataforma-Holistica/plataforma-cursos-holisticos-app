import type { ReactNode } from "react";

import { cx } from "./cx";
import { SeedMark } from "./flower";

// Un estado vacío o de espera (T-616): la semilla de la vida arriba, un título, lo que pasa y, si hay, qué
// hacer. Es uno de los tres lugares de la flor (flower.tsx). Va dentro de la pantalla, no la reemplaza: el
// de pantalla completa sigue siendo `FullScreenState`.
//
// La espera es una región de estado (`role="status"`). Un lector de pantalla anuncia lo que cambia dentro de una
// región que ya estaba en la página, no siempre una que aparece ya con su texto: quien la use para avisar de algo
// nuevo la deja montada y cambia su título. La flor no se mueve (una sola entrada por pantalla); lo que dice que se
// espera es el texto.

export interface FlowerStateProps {
  title: string;
  children?: ReactNode;
  /** El botón o el enlace de lo que se puede hacer. */
  action?: ReactNode;
  waiting?: boolean;
  className?: string;
}

export function FlowerState({ title, children, action, waiting = false, className }: FlowerStateProps) {
  return (
    <div role={waiting ? "status" : undefined} className={cx("flex flex-col items-center gap-4 px-6 py-12 text-center", className)}>
      <SeedMark waiting={waiting} className="size-24" />
      <p className="font-display text-h3 text-text">{title}</p>
      {children !== undefined && <div className="max-w-reading text-body text-text-2">{children}</div>}
      {action}
    </div>
  );
}
