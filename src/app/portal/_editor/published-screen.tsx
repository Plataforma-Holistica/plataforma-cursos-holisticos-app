"use client";

import { useActionState } from "react";

import { portal } from "@/messages/es/portal";
import { ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";
import { StatusBadge } from "@/ui/status-badge";
import { TextLink } from "@/ui/text-link";

import { openVersionAction } from "../_cursos/actions";
import type { OpenState } from "../_cursos/outcomes";
import { PortalMain } from "../_lib/shell";
import { failureText } from "../_lib/words";
import type { PublishedView } from "./published";

// PA-43 de un curso publicado sin versión abierta (T-405, FL-36 paso 1): lo que ven los alumnos, en solo lectura, y «Editar», que abre la versión
// y vuelve al editor. Es un formulario: sin JavaScript funciona igual.

const text = portal.published;
const IDLE: OpenState = { kind: "idle" };
const BLOCK_ID = "bloque-curso-publicado";

export function PublishedScreen({ view, path }: { view: PublishedView; path: string }) {
  const [state, action, pending] = useActionState(openVersionAction, IDLE, `${path}#${BLOCK_ID}`);

  return (
    <PortalMain
      title={view.title}
      titleId="curso-publicado-encabezado"
      above={<BackLink href={ROUTES.portalCourses}>{portal.editor.back}</BackLink>}
      badge={<StatusBadge tone={view.tone}>{view.state}</StatusBadge>}
    >
      <section id={BLOCK_ID} aria-labelledby="curso-publicado-encabezado" className="flex flex-col gap-6">
        {/* «Editar» es un formulario de este bloque: se queda adentro, para que sin JavaScript la respuesta vuelva a su ancla. */}
        {view.open !== null && (
          <form action={action}>
            <Button type="submit" name="do" value={view.open} loading={pending} loadingLabel={text.editing}>
              {text.edit}
            </Button>
          </form>
        )}
        <InlineAlert tone="neutral">{view.intro}</InlineAlert>
        {view.blocked !== null && <InlineAlert tone="neutral">{view.blocked}</InlineAlert>}
        {view.publicHref !== null && (
          <p>
            <TextLink href={view.publicHref}>{text.publicPage}</TextLink>
          </p>
        )}
        {state.kind === "failed" && (
          <InlineAlert tone={state.reason === "not_copyable" ? "neutral" : "danger"} live>
            {state.reason === "not_copyable" ? text.notCopyable : failureText(state.reason)}
          </InlineAlert>
        )}
        <p className="max-w-prose whitespace-pre-line text-body-l text-text-2">{view.summary}</p>
        <div className="flex flex-col gap-4">
          <h2 className="text-h3">{text.modules}</h2>
          <ol className="flex max-w-reading flex-col gap-4">
            {view.modules.map((module) => (
              <li key={module.id} className="flex flex-col gap-2 surface-raised p-4 sm:p-5">
                <h3 className="text-body-l font-semibold">{module.heading}</h3>
                <ol className="flex flex-col gap-1 border-l border-border pl-4">
                  {module.lessons.map((lesson) => (
                    <li key={lesson}>{lesson}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </PortalMain>
  );
}
