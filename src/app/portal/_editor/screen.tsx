"use client";

import { portal } from "@/messages/es/portal";
import { ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { InlineAlert } from "@/ui/inline-alert";
import { StatusBadge } from "@/ui/status-badge";
import { cx } from "@/ui/cx";

import { CourseBlock, ItemBlock, StructureBlock } from "./blocks";
import type { EditorView } from "./rows";
import { SavedStatus, UnsavedProvider } from "./unsaved";

// PA-43 · El editor de curso (T-402; RF-603, FL-32). Arriba, la barra: volver, el título, el estado y la
// hora del último guardado. A la izquierda la estructura; a la derecha lo elegido. En el teléfono, con
// algo elegido, el detalle va primero y enlaza de vuelta a la estructura (diseño, PA-43: «el detalle se
// abre encima»).
//
// Con JavaScript, la barra dice «Cambios sin guardar» mientras haya algo escrito sin enviar, y salir pide
// confirmar (`unsaved.tsx`); la estructura se ordena también arrastrando (`reorder.ts`). El video, los
// recursos y enviar a revisión llegan con T-403, T-404 y T-405. Mientras tanto «Guardar» es el botón
// principal (decisión mía sin confirmar).

const text = portal.editor;

export function EditorScreen({ view }: { view: EditorView }) {
  const chosen = view.selected.kind !== "course";
  return (
    <UnsavedProvider>
      <div className="flex flex-col gap-3 border-b border-border pb-4">
        <BackLink href={ROUTES.portalCourses}>{text.back}</BackLink>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-h1">{view.title}</h1>
          <StatusBadge tone={view.tone}>{view.state}</StatusBadge>
        </div>
        <SavedStatus saved={view.saved} />
      </div>
      {view.notice !== null && <InlineAlert tone="neutral">{view.notice}</InlineAlert>}
      <div className="grid gap-8 lg:grid-cols-editor">
        <div id="estructura" className={cx(chosen ? "order-2" : "order-1", "lg:order-1")}>
          <StructureBlock view={view} />
        </div>
        <div className={cx(chosen ? "order-1" : "order-2", "flex flex-col gap-4 lg:order-2")}>
          {chosen && (
            <a href="#estructura" className="min-h-touch content-center text-accent underline-offset-4 hover:underline lg:hidden">
              {text.backToStructure}
            </a>
          )}
          {view.selected.kind === "course" ? (
            <CourseBlock view={view} />
          ) : (
            <ItemBlock key={view.selected.id} view={view} selected={view.selected} />
          )}
        </div>
      </div>
    </UnsavedProvider>
  );
}
