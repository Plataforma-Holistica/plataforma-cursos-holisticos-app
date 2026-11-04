"use client";

import { useActionState } from "react";

import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";

import { failureText } from "../_lib/words";
import { discardVersionAction } from "./actions";
import type { DiscardState } from "./outcomes";

// Confirmar que se descartan los cambios a un curso publicado (T-405, H-18). Como borrar: es una pantalla y no un diálogo, así funciona igual sin
// JavaScript; «Cancelar» va primero y vuelve al editor, y el botón que confirma repite el verbo del título.

const text = portal.discardVersion;
const IDLE: DiscardState = { kind: "idle" };
const BLOCK_ID = "bloque-version-descartar";

export interface DiscardVersionScreenProps {
  title: string;
  /** El valor del botón que confirma: el curso y la revisión que se vio. */
  confirm: string;
  /** Esta misma ruta, ya armada. */
  path: string;
  /** El editor de la versión, a donde vuelve «Cancelar». */
  back: string;
  /** Ya se envió alguna vez: lo enviado y lo aceptado se quedan, y se dice. */
  wasSent: boolean;
}

export function DiscardVersionScreen({ title, confirm, path, back, wasSent }: DiscardVersionScreenProps) {
  const [state, action, pending] = useActionState(discardVersionAction, IDLE, `${path}#${BLOCK_ID}`);

  return (
    <section id={BLOCK_ID} aria-labelledby="version-descartar-encabezado" className="flex max-w-form flex-col gap-6">
      <h1 id="version-descartar-encabezado" className="text-h1">
        {text.title}
      </h1>
      <p className="text-body-l text-text-2">{t(text.body, { title })}</p>
      {wasSent && <p className="text-text-2">{text.keptNote}</p>}
      {state.kind === "failed" && (
        <InlineAlert tone="danger" live>
          {failureText(state.reason)}
        </InlineAlert>
      )}
      <form action={action} className="flex flex-wrap gap-3">
        <Button href={back} variant="secondary">
          {text.cancel}
        </Button>
        <Button type="submit" name="do" value={confirm} variant="danger" loading={pending} loadingLabel={text.discarding}>
          {text.confirm}
        </Button>
      </form>
    </section>
  );
}
