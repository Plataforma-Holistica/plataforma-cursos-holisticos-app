"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";

import { browse } from "@/messages/es/browse";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { Carousel } from "@/ui/carousel";
import { CourseCard } from "@/ui/course-card";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

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

const text = browse.myList;
const IDLE: ListState = { kind: "idle" };

export interface ListCourse {
  slug: string;
  href: string;
  title: string;
  teacherName: string;
  practice: { name: string; tone: number } | null;
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
}

const removeValue = (slug: string) => `remove:${slug}`;

export function MyListBlock({ action, courses, permalink, id }: MyListBlockProps) {
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

  const answer = !pending && state.kind !== "idle" ? state.kind : null;

  return (
    <div id={id} ref={block} className="flex flex-col gap-3">
      {courses.length > 0 && (
        <form ref={form} action={formAction} onSubmit={onSubmit}>
          <Carousel id="mi-lista" title={text.title}>
            {courses.map((course) => (
              <div key={course.slug} className="flex h-full flex-col items-start gap-3">
                <CourseCard
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
