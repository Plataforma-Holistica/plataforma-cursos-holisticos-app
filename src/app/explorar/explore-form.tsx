"use client";

import { Search, SlidersHorizontal, X } from "lucide";
import Form from "next/form";
import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";

import { browse } from "@/messages/es/browse";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { cx } from "@/ui/cx";
import { FieldLabel, INPUT_CLASSES } from "@/ui/field";
import { Icon } from "@/ui/icon";

// El buscador y los filtros de explorar (`SearchField` y `FilterChips`, diseño, sección 5.3;
// PA-21). Es un formulario GET a la misma página: sin JavaScript, «Buscar» lo envía y la
// dirección lleva lo pedido. Con JavaScript navega sin recargar (`next/form`), busca también al
// dejar de escribir 400 ms y al cambiar un filtro (con la misma pausa), no deja en la dirección los
// campos vacíos y no busca lo que ya se está mostrando.
//
// En el teléfono el buscador va arriba, fijo, y los filtros se abren con «Filtros» (sin
// JavaScript se ven siempre). Las etiquetas de los filtros activos las pinta la página.

const text = browse.explore;

/** Lo que se espera antes de buscar solo, al escribir o al cambiar un filtro. */
const PAUSE_MS = 400;

export interface ExploreFormOption {
  slug: string;
  name: string;
}

export interface ExploreFormProps {
  action: string;
  /** Lo que la página está mostrando: con eso arranca el formulario, y lo vuelve a tomar al cambiar. */
  query: { q: string | null; practice: string | null; teacher: string | null; level: string | null };
  /** La dirección de lo mostrado: cuando cambia, el formulario toma lo nuevo. */
  shownPath: string;
  /** La misma página sin la búsqueda, para el botón que la borra. */
  withoutSearch: string;
  practices: readonly ExploreFormOption[];
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

  const filter = (name: "practica" | "maestro" | "nivel", label: string, any: string, options: readonly ExploreFormOption[]) => (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
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
        className={INPUT_CLASSES}
      >
        <option value="">{any}</option>
        {options.map((option) => (
          <option key={option.slug} value={option.slug}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );

  // Dos piezas hermanas dentro de lo principal: el buscador es hijo directo, para que en el teléfono
  // se quede fijo arriba mientras se baja por los resultados (algo pegajoso solo se pega dentro de
  // la caja de su padre); los filtros van fuera del formulario y se le unen con `form`.
  return (
    <>
      <div className="sticky top-0 z-10 bg-bg px-4 py-2 sm:static sm:px-8 sm:py-0">
        <Form id={formId} ref={form} action={action} replace scroll={false} role="search" onSubmit={dropEmpty} className="flex flex-col gap-2">
          <FieldLabel htmlFor={`${ids}-q`}>{t(text.searchLabel)}</FieldLabel>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Icon icon={Search} size={20} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-3" />
              <input
                ref={box}
                id={`${ids}-q`}
                type="search"
                name="q"
                value={typed}
                maxLength={200}
                autoComplete="off"
                enterKeyHint="search"
                onFocus={() => setTyping(true)}
                onBlur={() => {
                  setTyping(false);
                  flush();
                }}
                onChange={(event) => {
                  setTyped(event.target.value);
                  submitSoon();
                }}
                className={cx(INPUT_CLASSES, "w-full pl-10", query.q !== null && "pr-12")}
              />
              {query.q !== null && (
                <Link
                  href={withoutSearch}
                  replace
                  scroll={false}
                  className="absolute top-1/2 right-0 flex size-touch -translate-y-1/2 items-center justify-center text-text-2 hover:text-text"
                >
                  <Icon icon={X} size={20} label={text.clearSearch} />
                </Link>
              )}
            </div>
            {/* Junto al campo también en el teléfono: el primario ocupa todo el ancho por omisión. */}
            <Button type="submit" className="shrink-0 max-sm:w-auto">
              {text.search}
            </Button>
          </div>
        </Form>
      </div>

      <div className="flex flex-col gap-4 px-4 sm:px-8">
        {js && (
          <div className="sm:hidden">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${ids}-filtros`}
              onClick={() => setOpen(!open)}
              className="inline-flex min-h-touch items-center gap-2 rounded-md border border-border px-4 text-body text-text hover:bg-surface-2"
            >
              <Icon icon={SlidersHorizontal} size={20} />
              {text.filters}
            </button>
          </div>
        )}
        <div id={`${ids}-filtros`} className={cx("flex flex-col gap-4 sm:flex-row", js && !open && "hidden sm:flex")}>
          {filter("practica", text.practice, text.anyPractice, practices)}
          {filter("maestro", t(text.teacher), t(text.anyTeacher), teachers)}
          {filter("nivel", text.level, text.anyLevel, levels)}
        </div>
      </div>
    </>
  );
}
