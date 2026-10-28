"use client";

import { ChevronLeft, ChevronRight } from "lucide";
import { Children, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { t } from "@/messages/format";
import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { Icon } from "./icon";

// Carrusel (`Carousel`, diseño, sección 5.3; RF-301; T-210): una fila de tarjetas que se recorre
// en horizontal, con desplazamiento nativo y ajuste a tarjeta. En escritorio, flechas de 44 px a
// los lados que avanzan una pantalla de tarjetas; la de un lado desaparece cuando ya no hay más
// de ese lado. Nunca avanza solo. Deslizar no es la única forma de avanzar (WCAG 2.5.7): cada
// tarjeta es una parada del tabulador, y el navegador la trae a la vista al recibir el foco.
//
// Sin JavaScript la fila se desliza igual; las flechas solo aparecen cuando el componente ya
// sabe medir.

const WIDTHS = {
  // 16:9: en el teléfono, 3/4 del ancho para que asome la siguiente.
  wide: "w-9/12 sm:w-72",
  // 2:3: un poco menos de la mitad.
  tall: "w-5/12 sm:w-44",
} as const;

export interface CarouselProps {
  /** El `id` del título de la fila: la sección se nombra con él. */
  id: string;
  title: string;
  shape?: keyof typeof WIDTHS;
  /** Un enlace a la derecha del título («Ver todo»), si la fila tiene uno. */
  action?: ReactNode;
  children: ReactNode;
}

export function Carousel({ id, title, shape = "wide", action, children }: CarouselProps) {
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState<{ start: boolean; end: boolean } | null>(null);

  const measure = useCallback(() => {
    const element = list.current;
    if (element === null) return;
    // Un píxel de tolerancia: el ajuste a tarjeta deja a veces medio píxel.
    setEdges({ start: element.scrollLeft > 1, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 });
  }, []);

  useEffect(() => {
    const element = list.current;
    if (element === null) return;
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    // Sin `ResizeObserver` (un navegador viejo), se mide al desplazar y nada más.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure]);

  // La flecha que tiene el foco. Al llegar al final con el teclado, la de ese lado ya no hace
  // falta, pero quitarla tiraría el foco al documento (WCAG 2.4.3): se queda, inactiva, hasta que
  // el foco se va. Lo encontró la revisión del diff.
  const [focused, setFocused] = useState<1 | -1 | null>(null);
  const shown = (direction: 1 | -1) => (direction === 1 ? edges?.end === true : edges?.start === true);

  const move = (direction: 1 | -1) => {
    const element = list.current;
    if (element === null || !shown(direction)) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollBy({ left: direction * element.clientWidth * 0.9, behavior: reduced ? "auto" : "smooth" });
  };

  const arrow = "absolute top-1/3 z-10 hidden size-touch -translate-y-1/2 items-center justify-center rounded-full bg-surface-3 text-text shadow-raised hover:bg-surface-2 aria-disabled:cursor-default aria-disabled:text-text-disabled md:flex";

  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4 px-4 sm:px-8">
        <h2 id={id} className="text-h2">
          {title}
        </h2>
        {action}
      </div>
      <div className="relative">
        {(shown(-1) || focused === -1) && (
          <button
            type="button"
            onClick={() => move(-1)}
            onFocus={() => setFocused(-1)}
            onBlur={() => setFocused(null)}
            aria-disabled={!shown(-1)}
            className={cx(arrow, "left-2")}
          >
            <Icon icon={ChevronLeft} size={24} label={t(ui.carousel.previous, { row: title })} />
          </button>
        )}
        <ul
          ref={list}
          aria-labelledby={id}
          className="flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 scrollbar-none sm:scroll-px-8 sm:px-8"
        >
          {Children.toArray(children).map((child, index) => (
            // `toArray` ya quitó lo vacío y le dio a cada tarjeta su propia llave. `relative`: el
            // nombre de la tarjeta (`sr-only`) es absoluto, y sin un ancestro posicionado dentro de
            // la lista se escaparía de ella y ensancharía la página entera.
            <li key={isValidElement(child) && child.key !== null ? child.key : index} className={cx("relative shrink-0 snap-start", WIDTHS[shape])}>
              {child}
            </li>
          ))}
        </ul>
        {(shown(1) || focused === 1) && (
          <button
            type="button"
            onClick={() => move(1)}
            onFocus={() => setFocused(1)}
            onBlur={() => setFocused(null)}
            aria-disabled={!shown(1)}
            className={cx(arrow, "right-2")}
          >
            <Icon icon={ChevronRight} size={24} label={t(ui.carousel.next, { row: title })} />
          </button>
        )}
      </div>
    </section>
  );
}
