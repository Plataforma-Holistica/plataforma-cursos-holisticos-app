"use client";

import { type ReactNode, useEffect, useRef } from "react";

// El título de una pantalla que sustituye a la pedida: recibe el foco al aparecer, para
// que quien usa lector de pantalla sepa que la pantalla cambió.
export function FocusHeading({ children, className }: { children: ReactNode; className?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <h1 ref={heading} tabIndex={-1} className={className}>
      {children}
    </h1>
  );
}
