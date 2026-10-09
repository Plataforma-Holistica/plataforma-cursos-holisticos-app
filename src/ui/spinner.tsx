import { LoaderCircle } from "lucide";

import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { Icon } from "./icon";

// Indicador de carga (diseño, sección 5.5): un arco que gira. Con movimiento reducido es
// una barra quieta con su texto. Siempre tiene nombre.

export interface SpinnerProps {
  size?: 16 | 24 | 40;
  /** Qué se está esperando. Si no se dice, «Cargando…». */
  label?: string;
  /** Dentro de un control que ya dice lo que pasa (un botón): no se anuncia otra vez. */
  decorative?: boolean;
  className?: string;
}

export function Spinner({ size = 24, label = ui.spinner.loading, decorative = false, className }: SpinnerProps) {
  return (
    <span
      role={decorative ? undefined : "status"}
      aria-hidden={decorative ? true : undefined}
      className={cx("inline-flex items-center gap-2", className)}
    >
      <Icon icon={LoaderCircle} size={size} className="animate-spin motion-reduce:hidden" />
      <span data-still className="hidden h-0.5 w-4 bg-current motion-reduce:block" />
      {!decorative && <span className="sr-only motion-reduce:not-sr-only">{label}</span>}
    </span>
  );
}
