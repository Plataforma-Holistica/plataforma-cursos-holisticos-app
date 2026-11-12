"use client";

import { Bookmark, BookmarkCheck } from "lucide";
import { useActionState, type FormEvent } from "react";

import { browse } from "@/messages/es/browse";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { cx } from "@/ui/cx";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { Spinner } from "@/ui/spinner";

import type { ListState } from "./outcomes";

// «Guardar en mi lista» o «Quitar de mi lista» (RF-311; PA-02 y PA-21; T-210): el botón de la
// ficha del curso y el de cada tarjeta de explorar. Si el curso está guardado lo dice la página
// (`saved`), que se vuelve a pedir después de cada envío: el texto cambia con lo que la base dice,
// no con lo que el botón supone. El texto visible es la acción; el nombre para quien no ve lleva
// además el curso, porque en explorar hay uno por tarjeta (sin `aria-pressed`: el texto ya cambia,
// y se leería dos veces; decisión mía sin confirmar).
//
// Mientras el envío va en camino el botón no se deshabilita (perdería el foco): no envía otra vez.
// El resultado se dice en una región que existe desde antes, y lo que salió mal también se ve.
//
// `variant="icon"` (T-616, solicitud 3; lo decidió el prototipo de la dirección, del carril A, y cambia la decisión de Sergio
// del 2026-10-28 de ponerlo bajo la tarjeta): un marcador sobre la esquina de la portada (`corner` de `CourseCard`), de 44 px,
// translúcido, en oro si ya está guardado. Su nombre es el mismo de siempre, con el curso, y lo que se ve es solo el icono.
// Mientras va en camino, la rueda en su lugar, sin deshabilitarse. El aviso de lo que salió mal cuelga debajo del botón.

const text = browse.myList;
const IDLE: ListState = { kind: "idle" };

const SAID: Record<Exclude<ListState["kind"], "idle">, string> = {
  saved: text.saved,
  removed: text.removed,
  gone: text.gone,
  unavailable: text.unavailable,
};

export interface SaveCourseButtonProps {
  /** La acción de la pantalla: cada una vuelve a la suya. */
  action: (previous: ListState, form: FormData) => Promise<ListState>;
  slug: string;
  title: string;
  saved: boolean;
  /** A dónde vuelve el formulario sin JavaScript: la misma pantalla, en el lugar del botón. */
  permalink: string;
  /** Con su texto (la ficha) o como marcador de icono (la esquina de una tarjeta). */
  variant?: "text" | "icon";
  className?: string;
}

export function SaveCourseButton({ action, slug, title, saved, permalink, variant = "text", className }: SaveCourseButtonProps) {
  const [state, formAction, pending] = useActionState(action, IDLE, permalink);
  // Lo que contestó el envío de este botón, y solo mientras no hay otro en camino.
  const answer = !pending && state.kind !== "idle" && state.slug === slug ? state.kind : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (pending) event.preventDefault();
  };

  const named = <span className="sr-only">{t(saved ? text.removeNamed : text.saveNamed, { title })}</span>;
  const status = (
    <p role="status" className="sr-only">
      {answer === null ? null : SAID[answer]}
    </p>
  );
  const failed = answer === "gone" || answer === "unavailable";

  if (variant === "icon") {
    return (
      <form action={formAction} onSubmit={onSubmit} className={cx("relative", className)}>
        <button
          type="submit"
          name="do"
          value={`${saved ? "remove" : "save"}:${slug}`}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          className={cx(
            "relative flex size-touch cursor-pointer items-center justify-center rounded-full float-plane edge-light transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-3 aria-busy:cursor-progress",
            saved ? "text-accent" : "text-text",
          )}
        >
          {pending ? <Spinner size={16} decorative /> : <Icon icon={saved ? BookmarkCheck : Bookmark} size={20} />}
          {named}
        </button>
        {status}
        {failed && (
          // Cabe a lo ancho de una tarjeta de la columna de la izquierda en el teléfono, sin salirse de la ventana.
          <div className="absolute top-full right-0 z-(--z-dropdown) mt-2 w-48">
            <InlineAlert tone="warning">{SAID[answer]}</InlineAlert>
          </div>
        )}
      </form>
    );
  }

  return (
    <form action={formAction} onSubmit={onSubmit} className={cx("flex flex-col items-start gap-2", className)}>
      <Button
        type="submit"
        variant="secondary"
        name="do"
        value={`${saved ? "remove" : "save"}:${slug}`}
        pending={pending}
        loadingLabel={saved ? text.removing : text.saving}
      >
        <span aria-hidden="true">{saved ? text.remove : text.save}</span>
        {named}
      </Button>
      {status}
      {failed && <InlineAlert tone="warning">{SAID[answer]}</InlineAlert>}
    </form>
  );
}
