"use client";

import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import { cx } from "./cx";

// Pestañas (`Tabs`, diseño, sección 5.2): partir una pantalla en vistas hermanas. La activa va
// subrayada en `accent`; las demás, en `text-2`. Con las flechas se cambia de pestaña (Inicio y
// Fin van a la primera y a la última), y Tab entra al panel. En teléfono, si no caben, se
// desplazan en horizontal.
//
// Sin JavaScript no hay con qué cambiar de pestaña: se pintan todos los paneles uno tras otro,
// cada uno con su título, y nada queda escondido.
//
// Una pestaña puede existir solo en pantallas angostas (`narrowOnly`): la lección lleva el temario en
// su columna en escritorio, y en el teléfono como pestaña. Así una sola lista sirve a los dos anchos y
// su contenido va una sola vez en el documento. Si en escritorio queda una sola, va como sección (PA-22).

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
  /**
   * Si el panel tiene algo que recibe el foco (enlaces, botones). Entonces el panel mismo no es
   * una parada de tabulación: Tab va a lo primero de adentro. Si no, el panel la es, para que
   * se pueda llegar a leerlo.
   */
  hasFocusableContent?: boolean;
  /** Solo en pantallas angostas: desde `lg` no aparece. */
  narrowOnly?: boolean;
}

export interface TabsProps {
  /** El nombre de la lista de pestañas, para quien no la ve. */
  label: string;
  items: TabItem[];
  /** El prefijo de los `id`: dos listas en la misma página no los comparten. */
  idPrefix: string;
}

const noSubscription = () => () => {};

/** Desde `lg` (64rem), como la clase de Tailwind. Sin `matchMedia` (el DOM de las pruebas), angosta. */
const WIDE = "(min-width: 64rem)";
const wideQuery = () => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE) : null);
function subscribeWide(change: () => void) {
  const query = wideQuery();
  query?.addEventListener("change", change);
  return () => query?.removeEventListener("change", change);
}

export function Tabs({ label, items: all, idPrefix }: TabsProps) {
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const wide = useSyncExternalStore(
    subscribeWide,
    () => wideQuery()?.matches ?? false,
    () => false,
  );
  const items = mounted && wide ? all.filter((item) => item.narrowOnly !== true) : all;
  const [chosen, setActive] = useState(items[0]?.id ?? "");
  // La elegida puede dejar de existir con la pantalla abierta (o al ensancharse): sin esto, ningún panel se vería y el teclado no tendría a dónde entrar.
  const active = items.some((item) => item.id === chosen) ? chosen : (items[0]?.id ?? "");
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  if (!mounted || (items.length === 1 && all.length > 1)) {
    return (
      <div className="flex flex-col gap-6">
        {items.map((item) => (
          <section
            key={item.id}
            aria-labelledby={`${idPrefix}-${item.id}-title`}
            className={item.narrowOnly === true ? "flex flex-col gap-3 lg:hidden" : "flex flex-col gap-3"}
          >
            <h2 id={`${idPrefix}-${item.id}-title`} className="text-h3">
              {item.label}
            </h2>
            {item.panel}
          </section>
        ))}
      </div>
    );
  }

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = items.length - 1;
    const target = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const item = items[target];
    if (item === undefined) return;
    setActive(item.id);
    buttons.current.get(item.id)?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label={label} className="flex gap-6 overflow-x-auto border-b border-border">
        {items.map((item, index) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              ref={(element) => {
                if (element) buttons.current.set(item.id, element);
                else buttons.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-${item.id}-tab`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-${item.id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(item.id)}
              onKeyDown={(event) => move(event, index)}
              className={cx(
                "-mb-px min-h-touch shrink-0 border-b-2 text-body transition-colors duration-(--duration-fast) ease-standard",
                selected ? "border-accent text-text" : "border-transparent text-text-2 hover:text-text",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${idPrefix}-${item.id}-panel`}
          aria-labelledby={`${idPrefix}-${item.id}-tab`}
          tabIndex={item.hasFocusableContent === true ? undefined : 0}
          hidden={item.id !== active}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
