"use client";

import { portal } from "@/messages/es/portal";
import { ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";
import { StatusBadge } from "@/ui/status-badge";
import { cx } from "@/ui/cx";

import { PortalMain } from "../_lib/shell";
import { CourseBlock, ItemBlock, StructureBlock } from "./blocks";
import type { EditorView } from "./rows";
import { SavedStatus, UnsavedProvider } from "./unsaved";
import { VideoUploadsProvider } from "./video-uploads";

// PA-43 · El editor de curso (T-402; RF-603, FL-32). Arriba, la barra: volver, el título, el estado y la
// hora del último guardado. A la izquierda la estructura; a la derecha lo elegido. En el teléfono, con
// algo elegido, el detalle va primero y enlaza de vuelta a la estructura (diseño, PA-43: «el detalle se
// abre encima»).
//
// Con JavaScript, la barra dice «Cambios sin guardar» mientras haya algo escrito sin enviar, y salir pide
// confirmar (`unsaved.tsx`); la estructura se ordena también arrastrando (`reorder.ts`). Las subidas de video
// viven aquí, por encima del detalle: cambiar de lección no las corta (`video-uploads.tsx`). Enviar a revisión
// llega con T-405. Mientras tanto «Guardar» es el botón principal (decisión mía sin confirmar).
//
// Un solo principal por pantalla (T-616): «Guardar», que es lo que más se hace. «Enviar a revisión» y «Agregar
// módulo» van de secundarios; `Button` no tiene una secundaria fuerte, así que «Enviar» se distingue por ir primero.

const text = portal.editor;

export function EditorScreen({ view }: { view: EditorView }) {
  const chosen = view.selected.kind !== "course";
  return (
    <UnsavedProvider>
      <VideoUploadsProvider course={view.course} lessons={view.lessonIds} checkEverySeconds={view.checkVideosEvery}>
        {/* La barra es la cabecera del armazón, dentro de los proveedores: el último guardado lee de ellos. */}
        <PortalMain
          title={view.title}
          above={<BackLink href={ROUTES.portalCourses}>{text.back}</BackLink>}
          badge={<StatusBadge tone={view.tone}>{view.state}</StatusBadge>}
          header={
            <div className="flex flex-col gap-3 pt-2">
              {(view.submitHref !== null || view.discardHref !== null) && (
                <div className="flex flex-wrap gap-3">
                  {view.submitHref !== null && (
                    <Button href={view.submitHref} variant="secondary">
                      {text.submit}
                    </Button>
                  )}
                  {view.discardHref !== null && (
                    <Button href={view.discardHref} variant="secondary">
                      {text.discard}
                    </Button>
                  )}
                </div>
              )}
              <SavedStatus saved={view.saved} />
            </div>
          }
        >
          <div className="flex flex-col gap-3 empty:hidden">
            {view.returned !== null && (
              <InlineAlert tone="warning">
                <span className="block font-semibold">{view.returned.title}</span>
                <span className="mt-2 block font-medium">{text.returned.reason}</span>
                <span className="block whitespace-pre-line break-words">{view.returned.reason}</span>
                <span className="mt-2 block font-medium">{text.returned.whatToFix}</span>
                <span className="block whitespace-pre-line break-words">{view.returned.whatToFix}</span>
                {view.editable && <span className="mt-2 block">{text.returned.resend}</span>}
              </InlineAlert>
            )}
            {view.notice !== null && <InlineAlert tone="neutral">{view.notice}</InlineAlert>}
          </div>
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
        </PortalMain>
      </VideoUploadsProvider>
    </UnsavedProvider>
  );
}
