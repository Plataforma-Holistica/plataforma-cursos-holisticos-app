"use client";

import { ArrowRight, ChevronDown, Search, SlidersHorizontal, X } from "lucide";
import Form from "next/form";
import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";

import { browse } from "@/messages/es/browse";
import { t } from "@/messages/format";
import { cx } from "@/ui/cx";
import { Icon } from "@/ui/icon";

// El buscador y los filtros de explorar (`SearchField` y `FilterChips`, diseño, sección 5.3;
// PA-21). Es un formulario GET a la misma página: sin JavaScript, «Buscar» lo envía y la
// dirección lleva lo pedido. Con JavaScript navega sin recargar (`next/form`), busca también al
// dejar de escribir 400 ms y al cambiar un filtro (con la misma pausa), no deja en la dirección los
// campos vacíos y no busca lo que ya se está mostrando.
//
// En el teléfono el buscador va arriba, fijo, y los filtros se abren con «Filtros» (sin
// JavaScript se ven siempre). Las etiquetas de los filtros activos las pinta la página.
//
// T-616, solicitud 3 (lo decidió el prototipo de la dirección, del carril A; decisiones sin confirmar):
// - un solo buscador alto, de a lo más 720 px (`max-w-search`), redondeado y sobre una superficie elevada, con el envío como
//   botón de icono dentro del campo (su nombre es «Buscar»: sin JavaScript es el que busca);
// - la práctica como fichas, que son enlaces (las arma la página: un componente del navegador no recibe funciones), con la
//   elegida en un campo oculto para que buscar la conserve; en el teléfono se deslizan y se desvanecen en el borde;
// - maestro y nivel en selectores discretos, a la derecha de las fichas, en la misma fila desde `sm`.

const text = browse.explore;

/** Lo que se espera antes de buscar solo, al escribir o al cambiar un filtro. */
const PAUSE_MS = 400;

export interface ExploreFormOption {
  slug: string;
  name: string;
}

/** Una ficha de práctica: su nombre, a dónde lleva (lo mostrado con esa práctica) y si es la elegida. «Todas» va primero. */
export interface PracticeChip {
  name: string;
  href: string;
  current: boolean;
}

export interface ExploreFormProps {
  action: string;
  /** Lo que la página está mostrando: con eso arranca el formulario, y lo vuelve a tomar al cambiar. */
  query: { q: string | null; practice: string | null; teacher: string | null; level: string | null };
  /** La dirección de lo mostrado: cuando cambia, el formulario toma lo nuevo. */
  shownPath: string;
  /** La misma página sin la búsqueda, para el botón que la borra. */
  withoutSearch: string;
  practices: readonly PracticeChip[];
  teachers: readonly ExploreFormOption[];
  levels: readonly ExploreFormOption[];
}

/** Lo que pide una dirección de explorar, comparable: sin vacíos, en orden, la búsqueda sin espacios de más. */
function askedKey(pairs: Iterable<[string, FormDataEntryValue]>): string {
  return [...pairs]
    .map(([name, value]) => [name, typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : ""] as const)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join("&");
}

export function ExploreForm({ action, query, shownPath, withoutSearch, practices, teachers, levels }: ExploreFormProps) {
  const ids = useId();
  const formId = `${ids}-form`;
  const form = useRef<HTMLFormElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const js = useHydrated();
  const [typing, setTyping] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(query.q ?? "");
  const [chosen, setChosen] = useState({ practica: query.practice ?? "", maestro: query.teacher ?? "", nivel: query.level ?? "" });

  // Lo mostrado cambió (un filtro quitado, atrás en el navegador): el formulario lo toma. Lo que
  // se está escribiendo no se pisa.
  const [seen, setSeen] = useState(shownPath);
  if (seen !== shownPath) {
    setSeen(shownPath);
    setChosen({ practica: query.practice ?? "", maestro: query.teacher ?? "", nivel: query.level ?? "" });
    if (!typing) setTyped(query.q ?? "");
  }

  // Next no mueve el foco al navegar: si el enlace pulsado (una etiqueta, «Limpiar filtros», la X)
  // se fue con la respuesta, el foco cayó al documento, y lo toma el buscador. Al cargar, no.
  const painted = useRef(shownPath);
  useEffect(() => {
    if (painted.current === shownPath) return;
    painted.current = shownPath;
    if (document.activeElement === null || document.activeElement === document.body) box.current?.focus({ preventScroll: true });
  }, [shownPath]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  /** Envía ya. Lo que se envía solo no sale si pide lo mismo que se está mostrando. */
  const submitNow = (alone: boolean) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const element = form.current;
    if (element === null) return;
    if (alone && askedKey(new FormData(element)) === askedKey(new URLSearchParams(shownPath.split("?")[1] ?? ""))) return;
    element.requestSubmit();
  };
  const submitSoon = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => submitNow(true), PAUSE_MS);
  };
  // Al salir de un campo con un envío pendiente, sale ya: si lo que sigue es pulsar un enlace, su
  // navegación llega después y es la que queda.
  const flush = () => {
    if (timer.current !== null) submitNow(true);
  };

  // Los campos vacíos no viajan: se quedan sin nombre mientras se arma la dirección. Apagarlos
  // le quitaría el foco al que lo tiene (al borrar la búsqueda, al volver a «Todas»).
  const dropEmpty = (event: FormEvent<HTMLFormElement>) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const nameless = [...event.currentTarget.elements].flatMap((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && element.name !== "" && element.value.trim() === ""
        ? [[element, element.name] as const]
        : [],
    );
    for (const [field] of nameless) field.removeAttribute("name");
    setTimeout(() => {
      for (const [field, name] of nameless) field.setAttribute("name", name);
    }, 0);
  };

  // Un selector discreto: su nombre es para quien no lo ve; a la vista, la opción elegida («Todos los niveles») ya lo dice.
  const filter = (name: "maestro" | "nivel", label: string, any: string, options: readonly ExploreFormOption[]) => (
    <div className="relative min-w-0">
      <label htmlFor={`${ids}-${name}`} className="sr-only">
        {label}
      </label>
      <select
        id={`${ids}-${name}`}
        name={name}
        form={formId}
        value={chosen[name]}
        onChange={(event) => {
          setChosen({ ...chosen, [name]: event.target.value });
          // Con la pausa: con las flechas sobre la lista cerrada, cada tecla es un cambio.
          if (js) submitSoon();
        }}
        onBlur={flush}
        className={cx(
          "min-h-touch w-full max-w-64 cursor-pointer appearance-none truncate rounded-full border bg-surface-1 py-2 pr-10 pl-4 text-body-s text-text transition-colors duration-(--duration-fast) ease-standard halo-surface-1 hover:border-border-control",
          chosen[name] === "" ? "border-border" : "border-accent-muted",
        )}
      >
        <option value="">{any}</option>
        {options.map((option) => (
          <option key={option.slug} value={option.slug}>
            {option.name}
          </option>
        ))}
      </select>
      <Icon icon={ChevronDown} size={16} className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-text-3" />
    </div>
  );

  // Dos piezas hermanas dentro de lo principal: el buscador es hijo directo, para que en el teléfono
  // se quede fijo arriba mientras se baja por los resultados (algo pegajoso solo se pega dentro de
  // la caja de su padre); los filtros van fuera del formulario y se le unen con `form`.
  return (
    <>
      <div className="sticky top-0 z-10 bg-bg px-4 py-2 sm:static sm:bg-transparent sm:px-8 sm:py-0">
        <Form id={formId} ref={form} action={action} replace scroll={false} role="search" onSubmit={dropEmpty} className="w-full max-w-search">
          <label htmlFor={`${ids}-q`} className="sr-only">
            {t(text.searchLabel)}
          </label>
          <div className="relative">
            <Icon icon={Search} size={20} className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-text-3" />
            <input
              ref={box}
              id={`${ids}-q`}
              type="search"
              name="q"
              value={typed}
              maxLength={200}
              autoComplete="off"
              enterKeyHint="search"
              placeholder={t(text.searchLabel)}
              onFocus={() => setTyping(true)}
              onBlur={() => {
                setTyping(false);
                flush();
              }}
              onChange={(event) => {
                setTyped(event.target.value);
                submitSoon();
              }}
              className={cx(
                // Su sombra tapa el halo del foco global: con el foco, el halo vuelve (`shadow-focus`).
                "h-14 w-full rounded-full border border-border-control bg-surface-1 pl-13 text-body-l text-text shadow-raised halo-surface-1 placeholder:text-text-3 focus-visible:shadow-focus",
                query.q !== null ? "pr-28" : "pr-16",
              )}
            />
            <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
              {query.q !== null && (
                <Link href={withoutSearch} replace scroll={false} className="flex size-touch items-center justify-center rounded-full text-text-2 hover:text-text">
                  <Icon icon={X} size={20} label={text.clearSearch} />
                </Link>
              )}
              {/* El envío, dentro del campo: un botón de icono con su nombre. Sin JavaScript es el que busca. */}
              <button
                type="submit"
                className="flex size-touch cursor-pointer items-center justify-center rounded-full bg-accent text-on-accent transition-colors duration-(--duration-fast) ease-standard halo-surface-1 hover:bg-accent-strong"
              >
                <Icon icon={ArrowRight} size={20} label={text.search} />
              </button>
            </div>
          </div>
          {/* La práctica elegida viaja con la búsqueda: las fichas de abajo son enlaces, no campos. Va después del buscador:
              sin JavaScript la dirección sale en el orden de los campos, y empieza por la búsqueda (`/explorar?q=…`, FL-11). */}
          <input type="hidden" name="practica" value={chosen.practica} />
        </Form>
      </div>

      <div className="px-4 sm:px-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
          <nav aria-label={text.practice} className="min-w-0 sm:flex-1">
            {/* Aire arriba (`pt-3`, devuelto con `-mt-3`), como en `Carousel`: la lista desplaza en horizontal, y eso también
                recorta en vertical; sin él se cortaba el anillo de foco de las fichas. */}
            <ul className="-mx-4 -mt-3 flex snap-x gap-2 overflow-x-auto px-4 pt-3 pb-1 scrollbar-none max-sm:mask-r-from-85% sm:mx-0 sm:flex-wrap sm:px-0">
              {practices.map((chip) => (
                <li key={chip.href} className="shrink-0 snap-start">
                  <Link
                    href={chip.href}
                    replace
                    scroll={false}
                    aria-current={chip.current ? "true" : undefined}
                    className={cx(
                      "inline-flex min-h-touch items-center rounded-full border px-4 text-body-s whitespace-nowrap transition-colors duration-(--duration-fast) ease-standard",
                      chip.current ? "border-accent bg-accent-subtle text-text" : "border-border text-text-2 hover:border-border-control hover:text-text",
                    )}
                  >
                    {chip.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {js && (
            <div className="sm:hidden">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`${ids}-filtros`}
                onClick={() => setOpen(!open)}
                className="inline-flex min-h-touch items-center gap-2 rounded-full border border-border px-4 text-body-s text-text hover:bg-surface-2"
              >
                <Icon icon={SlidersHorizontal} size={20} />
                {text.filters}
              </button>
            </div>
          )}
          <div id={`${ids}-filtros`} className={cx("flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap", js && !open && "hidden sm:flex")}>
            {filter("maestro", t(text.teacher), t(text.anyTeacher), teachers)}
            {filter("nivel", text.level, text.anyLevel, levels)}
          </div>
        </div>
      </div>
    </>
  );
}
