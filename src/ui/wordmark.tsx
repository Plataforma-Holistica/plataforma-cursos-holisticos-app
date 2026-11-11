import { terms } from "@/messages/es/terms";

import { cx } from "./cx";
import { FlowerMark } from "./flower";

// El logotipo provisional (diseño, sección 3.12): la flor de la vida delante del nombre del producto, en la
// tipografía de títulos. El nombre sale del catálogo de textos (`terms.Plataforma`; PQ-13, decidido el
// 2026-11-09); el que sigue provisional es el logotipo (D-01). Cambiar al definitivo es reemplazar este
// componente.
//
// Desde T-616 (solicitud 1; pedido de Sergio del 2026-11-11: «el logo debe ser importante que esté en toda
// página») la flor va siempre, sin que quien lo usa tenga que pedirla, y el punto de oro de la variante A
// (T-614, 2026-11-05) se retira: el oro ya está en la roseta del centro. La flor mide en `em` (los tokens
// `brand-mark`): crece con la letra. El tamaño lo pone quien lo usa, y el enlace también, si lo lleva.

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center font-display font-bold whitespace-nowrap text-text", className)}>
      <FlowerMark className="mr-brand-mark-gap" />
      {terms.Plataforma}
    </span>
  );
}
