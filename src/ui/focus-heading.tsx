"use client";

import { type ReactNode, useEffect, useRef } from "react";

// El título de una pantalla que sustituye a la pedida: recibe el foco al aparecer, para
// que quien usa lector de pantalla sepa que la pantalla cambió.
//
// No se le quita el anillo de foco: quien navega con teclado ve dónde quedó. El navegador
// solo lo pinta cuando hace falta (`:focus-visible`).
export function FocusHeading({
  children,
  className,
  focus = true,
}: {
  children: ReactNode;
  className?: string;
  /** Apagado cuando el título no es toda la pantalla, para no robarle el foco a nadie. */
  focus?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);

  return (
    <h1 ref={heading} tabIndex={-1} className={className}>
      {children}
    </h1>
  );
}
