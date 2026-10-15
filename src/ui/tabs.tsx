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

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
}

export interface TabsProps {
  /** El nombre de la lista de pestañas, para quien no la ve. */
  label: string;
  items: TabItem[];
  /** El prefijo de los `id`: dos listas en la misma página no los comparten. */
  idPrefix: string;
}

const noSubscription = () => () => {};

export function Tabs({ label, items, idPrefix }: TabsProps) {
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const [active, setActive] = useState(items[0]?.id ?? "");
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  if (!mounted) {
    return (
      <div className="flex flex-col gap-6">
        {items.map((item) => (
          <section key={item.id} aria-labelledby={`${idPrefix}-${item.id}-title`} className="flex flex-col gap-3">
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
          tabIndex={0}
          hidden={item.id !== active}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
