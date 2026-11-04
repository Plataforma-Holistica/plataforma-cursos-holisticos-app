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
    <section id={BLOCK_ID} aria-labelledby="curso-publicado-encabezado" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 border-b border-border pb-4">
        <BackLink href={ROUTES.portalCourses}>{portal.editor.back}</BackLink>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 id="curso-publicado-encabezado" className="text-h1">
            {view.title}
          </h1>
          <StatusBadge tone={view.tone}>{view.state}</StatusBadge>
        </div>
        {view.open !== null && (
          <form action={action}>
            <Button type="submit" name="do" value={view.open} loading={pending} loadingLabel={text.editing}>
              {text.edit}
            </Button>
          </form>
        )}
      </div>
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
        <h2 className="text-h2">{text.modules}</h2>
        <ol className="flex flex-col gap-4">
          {view.modules.map((module) => (
            <li key={module.id} className="flex flex-col gap-2 rounded-md border border-border p-4">
              <h3 className="text-h3">{module.heading}</h3>
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
  );
}
