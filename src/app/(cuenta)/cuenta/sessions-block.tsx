"use client";

import { useEffect, useRef } from "react";

import { account } from "@/messages/es/account";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { InlineAlert } from "@/ui/inline-alert";

import { CLOSE_OTHERS, type SessionsState } from "./outcomes";
import type { SessionRow } from "./rows";

// PA-25 · El bloque «Sesiones abiertas». La lista es propia de esta pantalla: una fila por
// sesión, en renglón cuando hay ancho y en tarjeta en teléfono. No lleva diálogo de
// confirmación: cerrar una sesión se deshace entrando otra vez.
//
// Todo el bloque es un solo formulario, y cada botón dice qué cierra con su `value`: así
// funciona sin JavaScript y el bloque tiene un solo estado. La sesión con la que se está
// viendo la lista no lleva botón: para esa está «Salir».

const text = account.manage;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
export const SESSIONS_BLOCK_ID = "bloque-sesiones";
const TITLE_ID = "cuenta-sesiones-titulo";

const RESULTS = { one: text.closedOne, others: text.closedOthers, gone: text.alreadyClosed } as const;

/** Lo que contestó el último envío, en palabras. Nulo si no hay nada que decir. */
function resultOf(state: SessionsState): string | null {
  if (state.kind === "closed") return RESULTS[state.what];
  return state.kind === "unavailable" ? account.common.unavailable : null;
}

export interface SessionsBlockProps {
  /** Las sesiones abiertas, como las leyó la página. La de ahora siempre viene. */
  sessions: readonly SessionRow[];
  state: SessionsState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function SessionsBlock({ sessions, state, action, pending }: SessionsBlockProps) {
  const others = sessions.some((session) => !session.current);
  const attempt = "attempt" in state ? state.attempt : 0;
  const result = pending ? null : resultOf(state);
  const notice = useRef<HTMLDivElement>(null);
  const spoken = useRef<HTMLSpanElement>(null);

  // Lo que contestó el último envío toma el foco al llegar: el botón que se pulsó suele ya
  // no existir, porque su fila se fue con la sesión, y sin esto el foco caería al documento.
  // El foco es también lo que se lo anuncia a quien usa lector de pantalla.
  //
  // Lo toma si nadie más lo tiene: si el foco está en algo que contiene al aviso (el
  // documento, la pantalla, el bloque) o en el propio bloque. A quien ya se fue a otra cosa
  // no se lo quita: quien pulsó «Cerrar» y se puso a escribir su nombre sigue escribiendo, y
  // el resultado se le dice por la región viva de `spoken`, que existe desde antes.
  useEffect(() => {
    const box = notice.current;
    const voice = spoken.current;
    if (attempt === 0 || result === null || box === null || voice === null) return;
    const active = document.activeElement;
    if (active === null || active.contains(box) || box.closest("section")?.contains(active) === true) {
      box.focus();
      return;
    }
    voice.textContent = result;
    return () => {
      voice.textContent = "";
    };
  }, [attempt, result]);

  return (
    <section id={SESSIONS_BLOCK_ID} aria-labelledby={TITLE_ID} className="flex flex-col gap-4">
      <h2 id={TITLE_ID} className="text-h3">
        {text.sessionsTitle}
      </h2>
      <p className="text-body-s text-text-2">{text.sessionsIntro}</p>
      {/* Lo que dijo el último envío deja de decirse mientras hay otro en camino. */}
      {result !== null && (
        <div ref={notice} tabIndex={-1}>
          <InlineAlert tone={state.kind === "closed" ? "success" : "danger"}>{result}</InlineAlert>
        </div>
      )}
      {/* Existen desde antes de cargar: una región que nace con su texto no siempre se anuncia. */}
      <p role="status" className="text-body-s text-text-2">
        {pending ? text.closingSessions : null}
      </p>
      {/* El resultado, para quien no tiene el foco en el aviso. Lo escribe el efecto de arriba. */}
      <span ref={spoken} role="status" className="sr-only" />
      <form action={action} className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1">
                <p className="text-body font-semibold">{session.device}</p>
                {session.opened !== null && <p className="text-body-s text-text-2">{session.opened}</p>}
                {session.lastActive !== null && <p className="text-body-s text-text-2">{session.lastActive}</p>}
              </div>
              {session.current ? (
                <p className="text-body-s font-semibold">{text.thisSession}</p>
              ) : (
                <Button type="submit" name="close" value={session.id} variant="secondary" disabled={pending}>
                  {text.closeOne}
                  {/* Sin el espacio, el nombre del botón se leería «Cerrarla sesión de…». */}
                  {SPACE}
                  <span className="sr-only">{session.closeDetail}</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
        {others ? (
          <p>
            <Button type="submit" name="close" value={CLOSE_OTHERS} variant="secondary" disabled={pending}>
              {text.closeOthers}
            </Button>
          </p>
        ) : (
          <p className="text-body-s text-text-2">{text.onlyThisSession}</p>
        )}
      </form>
    </section>
  );
}
