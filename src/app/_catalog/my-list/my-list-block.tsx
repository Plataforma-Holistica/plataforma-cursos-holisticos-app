"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";

import { browse } from "@/messages/es/browse";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { Carousel } from "@/ui/carousel";
import { CourseCard } from "@/ui/course-card";
import { cx } from "@/ui/cx";
import { FlowerState } from "@/ui/flower-state";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

import { takeArrival } from "../my-list-link";

import { MY_LIST_ARRIVAL } from "./arrival";
import type { ListState } from "./outcomes";

// El carrusel «Mi lista» del inicio (PA-20; RF-311; T-210): los cursos guardados, lo último
// primero, cada uno con «Quitar» debajo, fuera del enlace de la tarjeta. Es un solo formulario:
// cada botón dice qué curso con su `value`, y así funciona sin JavaScript (decisión de Sergio del
// 2026-10-28: al quitar, la tarjeta se va al momento).
//
// La tarjeta se va con la respuesta, y su botón con ella: el foco pasa al «Quitar» de la
// siguiente, o de la anterior, o al contenido si era la última (el carrusel se va con ella). Solo
// si la persona no se fue a otra cosa mientras esperaba: eso se anota mientras espera, con cada
// movimiento del foco, y no se deduce de dónde está el foco al llegar la respuesta. El resultado
// se dice en una región que existe desde antes y no se va con el carrusel.
//
// «Mi lista» de la barra del alumno lleva a este bloque por su ancla (T-616): al llegar toma el foco, y si no
// hay nada guardado lo dice, solo entonces: el inicio sin nada guardado sigue sin «Mi lista». La llegada la avisa
// el enlace (`MY_LIST_ARRIVAL`) si el bloque ya está pintado, o la deja en una marca de un solo uso que el bloque consume
// al montarse (`takeArrival`, 3b-1: montarse con el ancla en la dirección ya no basta, porque así tomaba el foco también
// al recargar; ver el efecto de la llegada, abajo); y `hashchange`, para quien escribe el ancla a mano. Sin JavaScript, la
// nota sale por `:target`.
//
// Desde T-616 (solicitud 3), la nota es un estado con la flor (`FlowerState`), y el aire de arriba lo pone quien lo usa en lo
// que se ve (`offset`): el bloque está siempre, también vacío, y no debe sumar aire si no muestra nada. La práctica de cada
// curso viaja con su orden en el catálogo, que elige el motivo de su portada.

const text = browse.myList;
const IDLE: ListState = { kind: "idle" };

export interface ListCourse {
  slug: string;
  href: string;
  title: string;
  teacherName: string;
  practice: { name: string; tone: number; slug?: string; position?: number } | null;
  levelName: string | null;
  lessonCount: number;
  isOpen: boolean;
}

export interface MyListBlockProps {
  action: (previous: ListState, form: FormData) => Promise<ListState>;
  courses: ListCourse[];
  /** A dónde vuelve el formulario sin JavaScript: el inicio, en este bloque. */
  permalink: string;
  /** El `id` del bloque, el ancla de `permalink`. */
  id: string;
  /** El aire de arriba, en lo que se ve (el carrusel o la nota), nunca en el bloque vacío. */
  offset?: string;
}

const removeValue = (slug: string) => `remove:${slug}`;

/**
 * Las cargas del documento que ya usó un bloque, por su entrada de navegación (`PerformanceNavigationTiming`, una por
 * documento): la bandera del módulo que se apaga tras el primer montaje, para que «Atrás» dentro de la aplicación no cuente
 * como llegada. Por la entrada y no un booleano suelto, para que cada carga (y cada prueba, que simula la suya) tenga la
 * suya.
 */
const usedLoads = new WeakSet<object>();

/** Si este es el primer montaje desde que cargó el documento y esa carga no fue una recarga. Sin saberlo, no. */
function firstLoad(): boolean {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return false;
  const entry = performance.getEntriesByType("navigation")[0] as (PerformanceEntry & { type?: string }) | undefined;
  if (entry === undefined || usedLoads.has(entry)) return false;
  usedLoads.add(entry);
  return entry.type !== undefined && entry.type !== "reload";
}

export function MyListBlock({ action, courses, permalink, id, offset }: MyListBlockProps) {
  const [state, formAction, pending] = useActionState(action, IDLE, permalink);
  const block = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // El curso que se pidió quitar y a cuál pasa el foco, anotados al enviar.
  const pressed = useRef<{ slug: string; next: string | null } | null>(null);
  const left = useRef(false);
  // El que se pinta «Quitando…».
  const [pressedSlug, setPressedSlug] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const value = submitter instanceof HTMLButtonElement ? submitter.value : "";
    const index = courses.findIndex((course) => removeValue(course.slug) === value);
    const course = courses[index];
    pressed.current = course === undefined ? null : { slug: course.slug, next: courses[index + 1]?.slug ?? courses[index - 1]?.slug ?? null };
    setPressedSlug(course?.slug ?? null);
    left.current = false;
  };

  // Mientras se espera, con cada movimiento del foco: irse es ponerlo en algo que no está en el
  // bloque ni lo contiene. Volver, o soltarlo en la página (un clic en un lugar vacío), ya no es
  // haberse ido.
  useEffect(() => {
    if (!pending) return;
    const onFocusIn = (event: FocusEvent) => {
      const here = block.current;
      if (!(event.target instanceof Node) || here === null) return;
      left.current = !(here.contains(event.target) || event.target.contains(here));
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget === null) left.current = false;
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [pending]);

  // Ya sin la tarjeta quitada, el foco pasa a la siguiente.
  useEffect(() => {
    const asked = pressed.current;
    if (pending || asked === null || state.kind !== "removed" || state.slug !== asked.slug) return;
    if (courses.some((course) => course.slug === asked.slug)) return;
    pressed.current = null;
    if (left.current) return;
    const next = asked.next === null ? null : form.current?.querySelector<HTMLButtonElement>(`button[value="${removeValue(asked.next)}"]`);
    (next ?? document.getElementById(MAIN_CONTENT_ID))?.focus();
  }, [state, courses, pending]);

  // Si se llegó por «Mi lista» de la barra: se dice que no hay nada guardado.
  const [arrived, setArrived] = useState(false);

  // Al llegar por la barra desde el mismo inicio, lo avisa el enlace, antes de que el enrutador desplace: el foco espera un
  // cuadro y no desplaza; el aviso usa también la marca, para que no quede viva para otro montaje. Al montarse, solo con el
  // ancla en la dirección y además la marca de la barra (llegada dentro de la aplicación, desde otra pantalla) o la primera
  // carga del documento que no fue una recarga (`firstLoad`: «Mi lista» pulsada antes de hidratar navega como un enlace del
  // navegador, sin marca). La marca se consume siempre al montarse, haya ancla o no: si quedara viva (una navegación
  // abandonada, o un inicio sin el bloque), el siguiente inicio con ancla tomaría el foco sin que nadie llegara por la barra.
  // Y si alguien escribe el ancla a mano (`hashchange`).
  useEffect(() => {
    const focus = () => {
      setArrived(true);
      requestAnimationFrame(() => block.current?.focus({ preventScroll: true }));
    };
    const fromBar = () => {
      takeArrival();
      focus();
    };
    const fromAddress = () => {
      if (window.location.hash === `#${id}`) focus();
    };
    // Los dos se consumen siempre: la marca y la primera carga se usan una sola vez.
    const marked = takeArrival();
    const fresh = firstLoad();
    if (window.location.hash === `#${id}` && (marked || fresh)) focus();
    window.addEventListener(MY_LIST_ARRIVAL, fromBar);
    window.addEventListener("hashchange", fromAddress);
    return () => {
      window.removeEventListener(MY_LIST_ARRIVAL, fromBar);
      window.removeEventListener("hashchange", fromAddress);
    };
  }, [id]);

  const answer = !pending && state.kind !== "idle" ? state.kind : null;

  return (
    // Un grupo con nombre: las tarjetas usan el suyo sin nombre (`group-hover`), y este las encendería todas a la vez.
    <div id={id} ref={block} tabIndex={-1} className="group/lista flex flex-col gap-3 outline-none">
      {courses.length === 0 && (
        <div data-list-empty className={cx(offset, arrived ? "block" : "hidden group-target/lista:block")}>
          <FlowerState title={text.emptyHereTitle}>{text.emptyHere}</FlowerState>
        </div>
      )}
      {courses.length > 0 && (
        <form ref={form} action={formAction} onSubmit={onSubmit} className={offset}>
          <Carousel id="mi-lista" title={text.title}>
            {courses.map((course) => (
              <div key={course.slug} className="flex h-full flex-col items-start gap-3">
                <CourseCard
                  courseKey={course.slug}
                  href={course.href}
                  title={course.title}
                  teacherName={course.teacherName}
                  practice={course.practice}
                  levelName={course.levelName}
                  lessonCount={course.lessonCount}
                  isOpen={course.isOpen}
                  className="w-full"
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="md"
                  name="do"
                  value={removeValue(course.slug)}
                  pending={pending && pressedSlug === course.slug}
                  held={pending && pressedSlug !== course.slug}
                  loadingLabel={text.removing}
                  className="mt-auto"
                >
                  <span aria-hidden="true">{text.removeShort}</span>
                  <span className="sr-only">{t(text.removeNamed, { title: course.title })}</span>
                </Button>
              </div>
            ))}
          </Carousel>
        </form>
      )}
      <p role="status" className="sr-only">
        {answer === "removed" ? text.removed : answer === "gone" ? text.gone : answer === "unavailable" ? text.unavailable : null}
      </p>
      {(answer === "gone" || answer === "unavailable") && (
        <div className="px-4 sm:px-8">
          <InlineAlert tone="warning">{answer === "gone" ? text.gone : text.unavailable}</InlineAlert>
        </div>
      )}
    </div>
  );
}
