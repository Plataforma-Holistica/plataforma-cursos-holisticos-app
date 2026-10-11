"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Lo poco que las pantallas de la cuenta saben del navegador en el que corren. Sin
// JavaScript nada de esto cambia: la pantalla se queda como la pintó el servidor.

const subscribeToNothing = () => () => undefined;

/** Falso en el servidor y en el primer dibujado; verdadero cuando ya corre en el navegador. */
export const useHydrated = (): boolean => useSyncExternalStore(subscribeToNothing, () => true, () => false);

/** Verdadero cuando ya pasó la hora de `until` (en formato ISO). Sin JavaScript no cambia: se recarga la pantalla. */
export function useWaitIsOver(until: string | null): boolean {
  const [passed, setPassed] = useState<string | null>(null);
  useEffect(() => {
    if (until === null) return;
    const wait = Math.max(0, new Date(until).getTime() - Date.now());
    // Un temporizador no acepta más de unos 24 días.
    const timer = setTimeout(() => setPassed(until), Math.min(wait, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [until]);
  return until !== null && passed === until;
}

// Si hay un botón del ratón (o un dedo, o un lápiz) abajo. Se anota desde que este código
// carga, porque el foco sale del campo después de que el botón baja.
let pointerIsDown = false;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", () => void (pointerIsDown = true), true);
  for (const type of ["pointerup", "pointercancel"]) {
    document.addEventListener(type, () => void (pointerIsDown = false), true);
  }
}

/** Con lo que termina la interacción que sacó el foco de un campo: se suelta el botón, o la tecla. */
const SETTLED = ["pointerup", "pointercancel", "keyup"] as const;
/** Lo que se espera cuando el foco salió sin botón abajo y no llega ninguna tecla. */
export const QUIET_MS = 150;

/**
 * Corre `work` cuando termina la interacción en curso, no en medio de ella. Es para lo que
 * se pinta al salir de un campo.
 *
 * Un clic en otro control saca el foco del campo al bajar el botón, antes de que el clic
 * exista. Si en ese instante aparece un mensaje de error, lo de abajo se recorre, el botón
 * se suelta sobre otra cosa y el clic se pierde: la persona pulsa «Guardar» y no pasa nada.
 * Por eso el mensaje espera a que el botón se suelte y el clic llegue a su destino.
 *
 * Sin botón abajo no hay clic que perder: espera a que se suelte la tecla, o un momento si
 * no llega ninguna, porque el foco también se mueve sin teclado ni ratón (el dictado, un
 * conmutador, un toque, que suelta antes de mover el foco).
 */
export function afterInteraction(work: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    for (const type of SETTLED) document.removeEventListener(type, run, true);
    // Después de que el clic, que sigue a soltar el botón, llegó a su destino.
    setTimeout(work, 0);
  };
  for (const type of SETTLED) document.addEventListener(type, run, true);
  if (!pointerIsDown) timer = setTimeout(run, QUIET_MS);
}
