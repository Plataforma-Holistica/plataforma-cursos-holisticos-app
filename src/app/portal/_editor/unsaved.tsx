"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { portal } from "@/messages/es/portal";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";

// Los cambios sin guardar del editor de curso (PA-43; tercera solicitud de T-402). Cada formulario dice
// cuándo se escribió en él (`mark(clave, true)`) y cuándo se envió (`mark(clave, false)`). Con algo sin
// guardar, la barra lo dice («Cambios sin guardar») y salir pide confirmar:
//
//   · Un enlace de la aplicación (el menú, «Mis cursos», otra lección de la estructura) se detiene antes de
//     que Next lo siga, y un diálogo pregunta. «Seguir editando» va primero; «Salir sin guardar» sigue el
//     enlace.
//   · Cerrar la pestaña, recargar o ir a otra dirección: el aviso del navegador (`beforeunload`), que el
//     navegador escribe a su manera.
//
// Sin JavaScript no hay nada de esto: la barra dice la hora del último guardado.

interface Unsaved {
  dirty: boolean;
  mark: (key: string, dirty: boolean) => void;
}

const UnsavedContext = createContext<Unsaved>({ dirty: false, mark: () => undefined });

export function useUnsaved(): Unsaved {
  return useContext(UnsavedContext);
}

/** Un enlace que lleva a otra pantalla de la aplicación, o nulo si no hay que detenerlo. */
function leavingLink(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return null;
  const to = new URL(link.href, window.location.href);
  if (to.origin !== window.location.origin) return null;
  // Un ancla dentro de la misma pantalla («Volver a la estructura») no sale.
  if (to.pathname === window.location.pathname && to.search === window.location.search && to.hash !== "") return null;
  return link;
}

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<string | null>(null);
  const dirty = keys.size > 0;
  const dirtyNow = useRef(dirty);

  const mark = useCallback((key: string, value: boolean) => {
    setKeys((current) => {
      if (current.has(key) === value) return current;
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    dirtyNow.current = dirty;
  }, [dirty]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyNow.current) return;
      event.preventDefault();
    };
    // En la fase de captura: antes de que el `Link` de Next navegue.
    const onClick = (event: MouseEvent) => {
      if (!dirtyNow.current) return;
      const link = leavingLink(event);
      if (link === null) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaving(link.href);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  const value = useMemo(() => ({ dirty, mark }), [dirty, mark]);
  const go = () => {
    const to = leaving;
    setLeaving(null);
    setKeys(new Set());
    dirtyNow.current = false;
    // Una carga completa: se sale del editor de todos modos, y así no hay estado que arrastrar.
    if (to !== null) window.location.assign(to);
  };

  return (
    <UnsavedContext.Provider value={value}>
      {children}
      {leaving !== null && (
        <Dialog
          title={portal.editor.leaveTitle}
          cancel={
            <Button type="button" variant="secondary" onClick={() => setLeaving(null)}>
              {portal.editor.leaveStay}
            </Button>
          }
          confirm={
            <Button type="button" variant="danger" onClick={go}>
              {portal.editor.leaveGo}
            </Button>
          }
        >
          {portal.editor.leaveBody}
        </Dialog>
      )}
    </UnsavedContext.Provider>
  );
}

/** Lo que dice la barra: «Cambios sin guardar» con algo escrito y sin enviar; si no, la hora del último guardado. */
export function SavedStatus({ saved }: { saved: string }) {
  const { dirty } = useUnsaved();
  return <p className="text-body-s text-text-2">{dirty ? portal.editor.unsaved : saved}</p>;
}
