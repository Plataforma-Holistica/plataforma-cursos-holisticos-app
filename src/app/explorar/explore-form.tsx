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
// dejar de escribir 400 ms y al cambiar un filtro, y no deja en la dirección los campos vacíos.
//
// En el teléfono el buscador va arriba, fijo, y los filtros se abren con «Filtros» (sin
// JavaScript se ven siempre). Las etiquetas de los filtros activos las pinta la página.

const text = browse.explore;

/** Lo que espera el buscador antes de buscar solo. */
const TYPING_PAUSE_MS = 400;

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

export function ExploreForm({ action, query, shownPath, withoutSearch, practices, teachers, levels }: ExploreFormProps) {
  const ids = useId();
  const form = useRef<HTMLFormElement>(null);
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

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const submitNow = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    form.current?.requestSubmit();
  };

  // Los campos vacíos no viajan: se apagan mientras se arma la dirección.
  const dropEmpty = (event: FormEvent<HTMLFormElement>) => {
    if (timer.current !== null) clearTimeout(timer.current);
    const fields = [...event.currentTarget.elements].filter(
      (element): element is HTMLInputElement | HTMLSelectElement =>
        (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && element.name !== "" && element.value.trim() === "",
    );
    for (const field of fields) field.disabled = true;
    setTimeout(() => {
      for (const field of fields) field.disabled = false;
    }, 0);
  };

  const filter = (name: "practica" | "maestro" | "nivel", label: string, any: string, options: readonly ExploreFormOption[]) => (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
      <select
        id={`${ids}-${name}`}
        name={name}
        value={chosen[name]}
        onChange={(event) => {
          setChosen({ ...chosen, [name]: event.target.value });
          if (js) submitNow();
        }}
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

  return (
    <Form ref={form} action={action} replace scroll={false} role="search" onSubmit={dropEmpty} className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-2 bg-bg px-4 py-2 sm:static sm:mx-0 sm:px-0">
        <FieldLabel htmlFor={`${ids}-q`}>{t(text.searchLabel)}</FieldLabel>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon icon={Search} size={20} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-3" />
            <input
              id={`${ids}-q`}
              type="search"
              name="q"
              value={typed}
              maxLength={200}
              autoComplete="off"
              enterKeyHint="search"
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
              onChange={(event) => {
                setTyped(event.target.value);
                if (timer.current !== null) clearTimeout(timer.current);
                timer.current = setTimeout(submitNow, TYPING_PAUSE_MS);
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
          <Button type="submit">{text.search}</Button>
        </div>
      </div>

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
    </Form>
  );
}
