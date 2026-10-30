"use client";

import { useActionState } from "react";

import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";

import { failureText } from "../_lib/words";
import { deleteCourseAction } from "./actions";
import type { DeleteState } from "./outcomes";

// Confirmar el borrado de un curso que nunca se envió (decisión de Sergio del 2026-10-29). Es una
// pantalla y no un diálogo: así funciona igual sin JavaScript. «Cancelar» va primero (diseño, `Dialog`),
// y el botón que confirma repite el verbo del título.

const text = portal.deleteCourse;
const IDLE: DeleteState = { kind: "idle" };
const BLOCK_ID = "bloque-curso-borrar";

export interface DeleteCourseScreenProps {
  title: string;
  /** El valor del botón que confirma: el curso y la revisión que se vio. */
  confirm: string;
  /** Esta misma ruta, ya armada. */
  path: string;
}

export function DeleteCourseScreen({ title, confirm, path }: DeleteCourseScreenProps) {
  const [state, action, pending] = useActionState(deleteCourseAction, IDLE, `${path}#${BLOCK_ID}`);

  return (
    <section id={BLOCK_ID} aria-labelledby="curso-borrar-encabezado" className="flex max-w-form flex-col gap-6">
      <h1 id="curso-borrar-encabezado" className="text-h1">
        {text.title}
      </h1>
      <p className="text-body-l text-text-2">{t(text.body, { title })}</p>
      {state.kind === "failed" && (
        <InlineAlert tone="danger" live>
          {failureText(state.reason)}
        </InlineAlert>
      )}
      <form action={action} className="flex flex-wrap gap-3">
        <Button href={ROUTES.portalCourses} variant="secondary">
          {text.cancel}
        </Button>
        <Button type="submit" name="do" value={confirm} variant="danger" loading={pending} loadingLabel={text.deleting}>
          {text.confirm}
        </Button>
      </form>
    </section>
  );
}
