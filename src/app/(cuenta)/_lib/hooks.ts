"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Lo poco que las pantallas de la cuenta saben del navegador en el que corren. Sin
// JavaScript nada de esto cambia: la pantalla se queda como la pintó el servidor.

const subscribeToNothing = () => () => undefined;

/** Falso en el servidor y en el primer dibujado; verdadero cuando ya corre en el navegador. */
export const useHydrated = (): boolean => useSyncExternalStore(subscribeToNothing, () => true, () => false);

/** Un temporizador no acepta más de unos 24 días. */
const MAX_TIMER_MS = 2_000_000_000;

/**
 * Verdadero cuando ya pasó la hora de `until` (en formato ISO). Sin JavaScript no cambia:
 * se recarga la pantalla. Es para una hora que además se le dice a la persona; para una
 * espera que solo se cuenta, `useDelayIsOver`, que no depende del reloj del navegador.
 */
export function useWaitIsOver(until: string | null): boolean {
  const [passed, setPassed] = useState<string | null>(null);
  useEffect(() => {
    if (until === null) return;
    const wait = Math.max(0, new Date(until).getTime() - Date.now());
    const timer = setTimeout(() => setPassed(until), Math.min(wait, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [until]);
  return until !== null && passed === until;
}

/**
 * Verdadero cuando ya pasaron `delayMs` desde que esa espera llegó al navegador. Lo que
 * falta lo contó el servidor: aquí solo se deja pasar ese tiempo, sin comparar relojes. Un
 * navegador con la hora adelantada no acorta la espera, y lo que tarda la respuesta en
 * llegar la alarga, que es el lado que no estorba.
 *
 * @param round Cuál espera es: al llegar otra, aunque dure lo mismo, se cuenta de nuevo.
 */
export function useDelayIsOver(delayMs: number | null, round: number): boolean {
  const [passed, setPassed] = useState<number | null>(null);
  useEffect(() => {
    if (delayMs === null) return;
    const timer = setTimeout(() => setPassed(round), Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [delayMs, round]);
  return delayMs !== null && passed === round;
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

/** Con lo que termina un clic: se suelta el botón, o el gesto se cancela. */
const POINTER_END = ["pointerup", "pointercancel"] as const;
/** Con lo que termina la interacción cuando no hay botón abajo: además, se suelta la tecla. */
const SETTLED = [...POINTER_END, "keyup"] as const;
/** Lo que se espera cuando el foco salió sin botón abajo y no llega ninguna tecla. */
export const QUIET_MS = 150;

/**
 * Corre `work` cuando termina la interacción en curso, no en medio de ella. Es para lo que
 * se pinta al salir de un campo.
 *
 * Un clic en otro control saca el foco del campo al bajar el botón, antes de que el clic
 * exista. Si en ese instante aparece un mensaje de error, lo de abajo se recorre, el botón
 * se suelta sobre otra cosa y el clic se pierde: la persona pulsa «Guardar» y no pasa nada.
 * Por eso el mensaje espera a que el botón se suelte y el clic llegue a su destino. Con el
 * botón abajo, soltar una tecla no cuenta: el clic sigue en curso.
 *
 * Sin botón abajo no hay clic que perder: espera a que se suelte la tecla, o un momento si
 * no llega ninguna, porque el foco también se mueve sin teclado ni ratón (el dictado, un
 * conmutador, un toque, que suelta antes de mover el foco).
 */
export function afterInteraction(work: () => void): void {
  const ends = pointerIsDown ? POINTER_END : SETTLED;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    for (const type of ends) document.removeEventListener(type, run, true);
    // Después de que el clic, que sigue a soltar el botón, llegó a su destino.
    setTimeout(work, 0);
  };
  for (const type of ends) document.addEventListener(type, run, true);
  if (!pointerIsDown) timer = setTimeout(run, QUIET_MS);
}

/**
 * Lo que se le dice a un campo: lo que se vio al salir de él, mientras no llegue una
 * revisión más nueva del formulario. Manda lo último que pasó.
 *
 * Sin esto, lo visto al salir del campo tapaba para siempre lo que dijera después una
 * revisión: quien dejaba un nombre válido, lo borraba y enviaba con Intro, leía «Escribe tu
 * nombre.» en el resumen y veía su campo sin marca.
 *
 * @param checked Lo que dijo la última revisión del formulario, al enviar o antes de enviar.
 * @param round Cuenta esas revisiones.
 * @returns Lo que el campo muestra, y con qué anotar lo que se vio al salir de él: un
 *   problema, nulo si está bien, o nada si quedó vacío (un campo vacío se marca al enviar).
 */
export function useSeenOnBlur<Problem extends string>(
  checked: Problem | undefined,
  round: number,
): readonly [Problem | undefined, (seen: Problem | null | undefined) => void] {
  const [last, setLast] = useState<{ round: number; seen: Problem | null } | null>(null);
  const shown = last !== null && last.round === round ? (last.seen ?? undefined) : checked;
  const see = (seen: Problem | null | undefined) =>
    afterInteraction(() => setLast(seen === undefined ? null : { round, seen }));
  return [shown, see];
}
