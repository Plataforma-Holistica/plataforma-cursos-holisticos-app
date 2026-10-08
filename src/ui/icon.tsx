import type { IconNode } from "lucide";
import { createElement } from "react";

// Un icono de Lucide, la única biblioteca de iconos (diseño, sección 3.8): trazo de 1.5 px
// sobre una rejilla de 24.
//
// Se dibuja en el servidor, sin JavaScript en el navegador. Por eso usa `lucide`, que
// entrega cada icono como una lista de trazos, y no `lucide-react`, que lo convertiría en
// un componente de navegador.
//
// Un icono nunca es la única señal: va junto a un texto, y entonces es decorativo. Solo
// cuando va solo lleva `label`, y ese nombre sale del catálogo.

const SIZES = { 16: "size-4", 20: "size-5", 24: "size-6" } as const;

export interface IconProps {
  icon: IconNode;
  size?: keyof typeof SIZES;
  /** El nombre del icono cuando no tiene un texto al lado. */
  label?: string;
  className?: string;
}

export function Icon({ icon, size = 20, label, className }: IconProps) {
  const classes = `${SIZES[size]} shrink-0${className ? ` ${className}` : ""}`;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={classes}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {icon.map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
    </svg>
  );
}
