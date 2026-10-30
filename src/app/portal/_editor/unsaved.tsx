"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { portal } from "@/messages/es/portal";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";

// Los cambios sin guardar del editor de curso (PA-43; tercera solicitud de T-402). Cada formulario tiene su
// clave: queda sin guardar al escribir en él, y se limpia solo cuando su bloque recibe la respuesta que lo
// guardó (no al enviarlo: un envío que no se hizo deja lo escrito en pantalla). Con alguna clave, la barra
// lo dice («Cambios sin guardar») y salir pide confirmar:
//
//   · Un enlace de la aplicación (el menú, «Mis cursos», otro módulo o lección) se detiene antes de que Next
//     lo siga, en la fase de captura, y un diálogo pregunta. «Seguir editando» va primero; «Salir sin
//     guardar» sale con una carga completa. Ir a otra cosa de la estructura cuando lo único sin guardar es
//     de la estructura no pregunta: la estructura no se desmonta y lo escrito se queda.
//   · Un formulario que se lleva a otra pantalla se detiene igual si perdería algo sin guardar de otro
//     formulario, y «Salir sin guardar» lo envía. Lo dice su `data-leaves`: `all` («Cerrar sesión») pierde
//     todo; `detail` (agregar un módulo o una lección, que abre lo agregado) pierde lo del bloque de la
//     derecha, no lo de la estructura.
//   · Cerrar la pestaña, recargar o ir a otra dirección: el aviso del navegador (`beforeunload`).
//   · Límite conocido (decisión mía sin confirmar): el botón «Atrás» del navegador es navegación de Next y no
//     pregunta.
//
// Sin JavaScript no hay nada de esto: la barra dice la hora del último guardado.

/** Las claves de la estructura empiezan así: ir a otra cosa de ella no las pierde. */
export const STRUCTURE_KEY = "estructura:";

interface Unsaved {
  dirty: boolean;
  mark: (key: string, dirty: boolean) => void;
}

const UnsavedContext = createContext<Unsaved>({ dirty: false, mark: () => undefined });

export function useUnsaved(): Unsaved {
  return useContext(UnsavedContext);
}

type Leaving = { kind: "link"; href: string } | { kind: "form"; form: HTMLFormElement; submitter: HTMLElement | null };

function plainClick(event: MouseEvent): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const dirty = keys.size > 0;
  const keysNow = useRef(keys);
  const passing = useRef<HTMLFormElement | null>(null);

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
    keysNow.current = keys;
  }, [keys]);

  useEffect(() => {
    /** Si irse con ese formulario perdería algo sin guardar de otro. */
    const loses = (form: HTMLFormElement) => {
      const own = form.getAttribute("data-unsaved-key");
      const detailOnly = form.getAttribute("data-leaves") === "detail";
      return [...keysNow.current].some((key) => key !== own && !(detailOnly && key.startsWith(STRUCTURE_KEY)));
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (keysNow.current.size === 0) return;
      event.preventDefault();
      // Los navegadores que no miran `preventDefault` piden un valor que no esté vacío (el texto no lo muestran).
      event.returnValue = portal.editor.leaveBody;
    };
    const onClick = (event: MouseEvent) => {
      if (keysNow.current.size === 0 || !plainClick(event)) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return;
      const to = new URL(link.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      const samePage = to.pathname === window.location.pathname;
      // Un ancla de la misma pantalla («Volver a la estructura») no sale.
      if (samePage && to.search === window.location.search && to.hash !== "") return;
      // Otra cosa de la estructura, con lo único sin guardar en la estructura: se queda.
      if (samePage && [...keysNow.current].every((key) => key.startsWith(STRUCTURE_KEY))) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaving({ kind: "link", href: link.href });
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-leaves")) return;
      if (passing.current === form) {
        passing.current = null;
        return;
      }
      if (!loses(form)) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaving({ kind: "form", form, submitter: event.submitter });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, []);

  const value = useMemo(() => ({ dirty, mark }), [dirty, mark]);
  const go = () => {
    const what = leaving;
    setLeaving(null);
    if (what === null) return;
    // Lo que se pierde, por decisión de quien sale: todo, o lo del bloque de la derecha si el formulario solo
    // abre otra cosa (lo de la estructura se queda en pantalla y sigue sin guardar).
    const detailOnly = what.kind === "form" && what.form.getAttribute("data-leaves") === "detail";
    const kept = new Set([...keysNow.current].filter((key) => detailOnly && key.startsWith(STRUCTURE_KEY)));
    keysNow.current = kept;
    setKeys(kept);
    if (what.kind === "link") {
      // Una carga completa: se sale del editor de todos modos, y así no hay estado que arrastrar.
      window.location.assign(what.href);
      return;
    }
    passing.current = what.form;
    what.form.requestSubmit(what.submitter instanceof HTMLButtonElement ? what.submitter : undefined);
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

/** Lo que dice la barra: «Cambios sin guardar» con algo escrito y sin guardar; si no, la hora del último guardado. */
export function SavedStatus({ saved }: { saved: string }) {
  const { dirty } = useUnsaved();
  return <p className="text-body-s text-text-2">{dirty ? portal.editor.unsaved : saved}</p>;
}
