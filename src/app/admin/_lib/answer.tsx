"use client";

import { type RefObject, useEffect, useRef } from "react";

import { InlineAlert } from "@/ui/inline-alert";

// Lo que comparten las secciones de administración que son una lista con botones (PA-86 y
// PA-67): a dónde va el foco cuando llega la respuesta, y cómo se dice el resultado.

/**
 * A dónde va el foco cuando un bloque con varios botones recibe su respuesta. El botón que
 * se pulsó queda inactivo mientras se espera, y muchas veces ya no existe al volver (su fila
 * se fue, o lo sustituyó la confirmación): sin esto el foco caería al documento. Lo toma lo
 * que contestó el envío, que es también lo que se lo anuncia a quien usa lector de pantalla.
 *
 * A quien se fue a otra cosa mientras esperaba no se le quita: se le dice por una región
 * viva que existe desde antes. Si se fue o no, no se deduce de dónde está el foco cuando
 * llega la respuesta, que engaña: se anota mientras se espera, con cada movimiento del foco.
 * Es la misma regla del bloque de sesiones de la cuenta.
 *
 * @param attempt El número de intento de la respuesta que se pinta, o 0 si no hay ninguna.
 * @param spokenText Lo que la respuesta dice, para la región viva. Nulo si no dice nada.
 */
export function useAnswerFocus(pending: boolean, attempt: number, spokenText: string | null) {
  const block = useRef<HTMLElement>(null);
  const answer = useRef<HTMLDivElement>(null);
  const spoken = useRef<HTMLSpanElement>(null);
  const away = useRef(false);
  const last = useRef(0);

  useEffect(() => {
    if (!pending) return;
    away.current = false;
    const note = (event: FocusEvent) => {
      const here = block.current;
      const to = event.target;
      away.current = here !== null && to instanceof Node && !to.contains(here);
    };
    document.addEventListener("focusin", note);
    return () => document.removeEventListener("focusin", note);
  }, [pending]);

  useEffect(() => {
    const before = last.current;
    last.current = attempt;
    if (attempt === 0) {
      // «Cancelar» quitó la confirmación, y con ella el botón pulsado: el foco vuelve al bloque.
      if (before !== 0 && !away.current) block.current?.focus();
      return;
    }
    const box = answer.current;
    const voice = spoken.current;
    if (box === null || voice === null) return;
    if (!away.current) {
      box.focus();
      return;
    }
    if (spokenText === null) return;
    voice.textContent = spokenText;
    return () => {
      voice.textContent = "";
    };
  }, [attempt, spokenText]);

  return { block, answer, spoken, away };
}

export interface BlockResultProps {
  /** Lo que contestó el último envío, en palabras. Nulo si no hay nada que decir. */
  message: string | null;
  tone: "success" | "warning" | "danger";
  pending: boolean;
  /** «Guardando…», mientras el envío va en camino. */
  pendingText: string;
  answer: RefObject<HTMLDivElement | null>;
  spoken: RefObject<HTMLSpanElement | null>;
}

/** El resultado de un bloque con varios botones, y sus dos regiones vivas. */
export function BlockResult({ message, tone, pending, pendingText, answer, spoken }: BlockResultProps) {
  return (
    <>
      {/* Lo que dijo el último envío deja de decirse mientras hay otro en camino. */}
      {message !== null && (
        <div ref={answer} tabIndex={-1} className="outline-none">
          <InlineAlert tone={tone}>{message}</InlineAlert>
        </div>
      )}
      {/* Existen desde antes de cargar: una región que nace con su texto no siempre se anuncia. */}
      <p role="status" className="text-body-s text-text-2">
        {pending ? pendingText : null}
      </p>
      {/* El resultado, para quien no tiene el foco en el aviso. Lo escribe `useAnswerFocus`. */}
      <span ref={spoken} role="status" className="sr-only" />
    </>
  );
}
