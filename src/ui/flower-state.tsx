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
//
// `size="compact"` (T-616, solicitud 3) es el de un lugar chico, como el del reproductor (PA-33): la semilla más chica y menos
// aire, para que quepa en un 16:9 del teléfono.

export interface FlowerStateProps {
  title: string;
  children?: ReactNode;
  /** El botón o el enlace de lo que se puede hacer. */
  action?: ReactNode;
  waiting?: boolean;
  size?: "regular" | "compact";
  className?: string;
}

// Las clases de cada tamaño: la caja, la semilla y el título.
const BOX = { regular: "gap-4 px-6 py-12", compact: "gap-2 px-4 py-4" } as const;
const SEED = { regular: "size-24", compact: "size-12" } as const;
const TITLE = { regular: "text-h3", compact: "text-body-l font-semibold" } as const;

export function FlowerState({ title, children, action, waiting = false, size = "regular", className }: FlowerStateProps) {
  return (
    <div role={waiting ? "status" : undefined} className={cx("flex flex-col items-center text-center", BOX[size], className)}>
      <SeedMark waiting={waiting} className={SEED[size]} />
      <p className={cx("font-display text-text", TITLE[size])}>{title}</p>
      {children !== undefined && <div className="max-w-reading text-body text-text-2">{children}</div>}
      {action}
    </div>
  );
}
