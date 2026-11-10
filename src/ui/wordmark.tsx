import { terms } from "@/messages/es/terms";

import { cx } from "./cx";

// El logotipo provisional (diseño, sección 3.12; T-614): el nombre del producto en la tipografía
// de títulos, con un punto del acento al final (la variante A, elegida por Sergio el 2026-11-05). El
// nombre sale del catálogo de textos (`terms.Plataforma`; PQ-13, decidido el 2026-11-09); el que sigue
// provisional es el logotipo (D-01). Cambiar al definitivo es reemplazar este componente.
//
// El punto mide y se separa en `em` (los tokens `brand-dot`): crece con la letra. El tamaño lo pone quien lo usa, y el enlace
// también, si lo lleva.

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("font-display font-bold whitespace-nowrap text-text", className)}>
      {terms.Plataforma}
      <span data-brand-dot aria-hidden="true" className="ml-brand-dot-gap inline-block size-brand-dot rounded-full bg-accent" />
    </span>
  );
}
