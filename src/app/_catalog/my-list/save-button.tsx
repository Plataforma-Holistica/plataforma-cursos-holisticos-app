"use client";

import { useActionState, type FormEvent } from "react";

import { browse } from "@/messages/es/browse";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { cx } from "@/ui/cx";
import { InlineAlert } from "@/ui/inline-alert";

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
  className?: string;
}

export function SaveCourseButton({ action, slug, title, saved, permalink, className }: SaveCourseButtonProps) {
  const [state, formAction, pending] = useActionState(action, IDLE, permalink);
  // Lo que contestó el envío de este botón, y solo mientras no hay otro en camino.
  const answer = !pending && state.kind !== "idle" && state.slug === slug ? state.kind : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (pending) event.preventDefault();
  };

  return (
    <form action={formAction} onSubmit={onSubmit} className={cx("flex flex-col items-start gap-2", className)}>
      <Button
        type="submit"
        variant="secondary"
        name="do"
        value={`${saved ? "remove" : "save"}:${slug}`}
        pending={pending}
        loadingLabel={saved ? text.removing : text.saving}
        className="max-sm:w-auto"
      >
        <span aria-hidden="true">{saved ? text.remove : text.save}</span>
        <span className="sr-only">{t(saved ? text.removeNamed : text.saveNamed, { title })}</span>
      </Button>
      <p role="status" className="sr-only">
        {answer === null ? null : SAID[answer]}
      </p>
      {(answer === "gone" || answer === "unavailable") && <InlineAlert tone="warning">{SAID[answer]}</InlineAlert>}
    </form>
  );
}
