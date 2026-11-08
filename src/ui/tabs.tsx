"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

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
  const root = useRef<HTMLDivElement>(null);

  // Al llegar el JavaScript, la pestaña activa es la que tiene el ancla de la dirección: ahí vuelve un envío hecho antes (los
  // comentarios vuelven a `#comentarios`), y lo que trajo no puede quedar detrás de otra pestaña. Antes de pintar, para que un
  // diálogo abierto en ese panel no quede dentro de algo escondido.
  useLayoutEffect(() => {
    if (!mounted || window.location.hash.length < 2) return;
    // Un ancla mal formada (`#100%`) no se puede decodificar: entonces no elige nada.
    let id: string;
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return;
    }
    const target = document.getElementById(id);
    const owner = target === null ? null : target.closest<HTMLElement>("[data-tab]");
    if (owner !== null && root.current?.contains(owner)) setActive(owner.dataset.tab ?? "");
  }, [mounted]);

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

  // Un solo árbol antes y después de que llegue el JavaScript: cada panel es la misma `<section>` con la misma llave, y lo que
  // cambia son sus atributos. Así no se vuelve a montar al hidratar, y lo que trajo el servidor (el estado de un envío sin
  // JavaScript) se conserva.
  const sections = !mounted || (items.length === 1 && all.length > 1);

  return (
    <div ref={root} className={sections ? "flex flex-col gap-6" : "flex flex-col gap-4"}>
      {sections ? null : (
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
      )}
      {items.map((item) => (
        <section
          key={item.id}
          data-tab={item.id}
          id={sections ? undefined : `${idPrefix}-${item.id}-panel`}
          role={sections ? undefined : "tabpanel"}
          aria-labelledby={sections ? `${idPrefix}-${item.id}-title` : `${idPrefix}-${item.id}-tab`}
          tabIndex={sections || item.hasFocusableContent === true ? undefined : 0}
          hidden={sections ? undefined : item.id !== active}
          className={sections ? cx("flex flex-col gap-3", item.narrowOnly === true && "lg:hidden") : undefined}
        >
          {sections ? (
            <h2 id={`${idPrefix}-${item.id}-title`} className="text-h3">
              {item.label}
            </h2>
          ) : null}
          {item.panel}
        </section>
      ))}
    </div>
  );
}
