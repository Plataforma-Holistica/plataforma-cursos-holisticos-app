"use client";

import { useEffect, useRef, type ReactNode } from "react";

// El menú de la persona en la barra del alumno (T-616, solicitud 2). Es un `<details>` antes y después de
// hidratar, el mismo árbol (la lección de `Tabs`: dos árboles se vuelven a montar), y sin JavaScript se abre y
// se cierra igual. El JavaScript solo agrega cerrarlo con Escape (el foco vuelve al resumen), con un clic fuera
// y al elegir una entrada. Sin `role="menu"`: son enlaces y un botón, y se recorren con Tab.

export function PersonMenu({ summary, className, children }: { summary: ReactNode; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = ref.current;
    if (details === null) return;
    const close = (focus: boolean) => {
      if (!details.open) return;
      details.open = false;
      if (focus) details.querySelector("summary")?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && details.open) {
        event.preventDefault();
        close(true);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.contains(event.target)) close(false);
    };
    // Elegir un enlace. El botón de cerrar la sesión no lo cierra: se iría el botón antes que su envío.
    const onChoose = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a") !== null) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    details.addEventListener("click", onChoose);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      details.removeEventListener("click", onChoose);
    };
  }, []);

  return (
    <details ref={ref} className={className}>
      {summary}
      {children}
    </details>
  );
}
