"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

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
  // Qué espera es la que ya pasó: la misma ronda con otra duración es otra espera.
  const id = `${round}:${delayMs}`;
  const [passed, setPassed] = useState<string | null>(null);
  useEffect(() => {
    if (delayMs === null) return;
    const timer = setTimeout(() => setPassed(id), Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [delayMs, id]);
  return delayMs !== null && passed === id;
}

// Si hay un botón del ratón (o un dedo, o un lápiz) abajo, sobre qué bajó, y lo que espera a
// que se suelte. Se anota desde que este código carga, porque el foco sale del campo
// después de que el botón baja.
let pointerIsDown = false;
let pressedOn: EventTarget | null = null;
const waitingForRelease: (() => void)[] = [];
const released = () => {
  pointerIsDown = false;
  pressedOn = null;
  // Lo que esperaba a que el clic terminara, en su orden y después de que el clic, que
  // sigue a soltar el botón, llegó a su destino.
  for (const work of waitingForRelease.splice(0)) setTimeout(work, 0);
};
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      pointerIsDown = true;
      pressedOn = event.target;
    },
    true,
  );
  // Soltar no siempre avisa: el menú del botón derecho o cambiar de ventana se lo tragan.
  // Sin estas otras salidas el botón quedaría «abajo», y lo que espera a que se suelte
  // esperaría un clic que no viene.
  for (const type of ["pointerup", "pointercancel", "contextmenu", "dragend"]) document.addEventListener(type, released, true);
  window.addEventListener("blur", released);
}

/**
 * El elemento sobre el que está abajo el botón del ratón, o nulo si no hay ninguno abajo.
 * Es para saber que el foco salió de un campo hacia un botón que es parte de él: hay
 * navegadores que no le dan el foco a un botón al pulsarlo, y ahí el foco no dice a dónde fue.
 */
export function pressedElement(): Element | null {
  return pressedOn instanceof Element ? pressedOn : null;
}

/** Lo que se espera cuando el foco salió sin botón abajo y no llega ninguna tecla. */
export const QUIET_MS = 150;

/**
 * Corre `work` cuando termina la interacción en curso, no en medio de ella. Es para lo que
 * se pinta al salir de un campo.
 *
 * Un clic en otro control saca el foco del campo al bajar el botón, antes de que el clic
 * exista. Si en ese instante aparece un mensaje de error, lo de abajo se recorre, el botón
 * se suelta sobre otra cosa y el clic se pierde: la persona pulsa «Guardar» y no pasa nada.
 * Por eso, con el botón abajo, el mensaje espera a que se suelte y el clic llegue a su
 * destino. Soltar una tecla ahí no cuenta: el clic sigue en curso.
 *
 * Sin botón abajo no hay clic que perder: espera a que se suelte la tecla, o un momento si
 * no llega ninguna, porque el foco también se mueve sin teclado ni ratón (el dictado, un
 * conmutador, un toque, que suelta antes de mover el foco).
 */
export function afterInteraction(work: () => void): void {
  if (pointerIsDown) {
    waitingForRelease.push(work);
    return;
  }
  const run = () => {
    clearTimeout(timer);
    document.removeEventListener("keyup", run, true);
    setTimeout(work, 0);
  };
  const timer = setTimeout(run, QUIET_MS);
  document.addEventListener("keyup", run, true);
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

/**
 * Para un formulario cuya respuesta se pinta en la misma pantalla: devuelve el foco a donde
 * estaba al enviar, si la respuesta lo dejó sin dueño.
 *
 * Con cada respuesta los campos se arman de nuevo y el botón pasa por deshabilitado: el
 * elemento que tenía el foco desaparece o lo suelta, y el foco cae al documento. Quien guarda
 * con Intro desde un campo tendría que volver a buscarlo desde el principio de la página.
 * Donde el envío lleva a otra pantalla esto no hace falta.
 *
 * Solo actúa si el foco quedó sin dueño: si lo tomó el resumen de errores, o la persona ya
 * se movió a otra cosa, ahí se queda.
 *
 * @param answers Cuántas respuestas del servidor ha recibido el formulario.
 * @returns Con qué anotar, al enviar, dónde está el foco dentro de ese formulario.
 */
export function useFocusKept(answers: number): (form: HTMLFormElement) => void {
  const sentFrom = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const from = sentFrom.current;
    sentFrom.current = null;
    if (from === null) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    // Un campo que se armó de nuevo ya es otro elemento: se le encuentra por su `id`.
    const target = from.isConnected ? from : from.id === "" ? null : document.getElementById(from.id);
    target?.focus();
  }, [answers]);
  return (form) => {
    const active = document.activeElement;
    sentFrom.current = active instanceof HTMLElement && form.contains(active) ? active : null;
  };
}

/** Lo que lleva de las revisiones que el navegador hace de un formulario antes de enviarlo. */
export interface LocalChecks<Found> {
  /**
   * Si la última palabra sobre el formulario es de una revisión del navegador, y no de una
   * respuesta del servidor. Cuando lo es, lo que hay que corregir es `found` y nada más: lo
   * que dijo la respuesta anterior ya no se pinta, aunque la siguiente todavía no llegue.
   */
  latest: boolean;
  /** Lo que encontró la última, o nulo si no encontró nada y el formulario se envió. */
  found: Found | null;
  /**
   * Cuántas hubo, encontraran algo o no. No retrocede ni se queda quieta: es contra lo que
   * se mide si lo visto al salir de un campo sigue mandando (`useSeenOnBlur`), y lo que le
   * dice al resumen de errores que hay una revisión nueva.
   */
  checks: number;
}

/**
 * Las revisiones del navegador antes de enviar, y si son lo último que se sabe del formulario.
 *
 * La regla de la pantalla es la misma que la de cada campo: manda lo último que pasó. Una
 * respuesta del servidor manda hasta la siguiente revisión del navegador, y esa revisión
 * manda hasta la siguiente respuesta. Sin eso, al enviar bien lo que el servidor había
 * rechazado, el campo ya corregido volvía a marcarse con el error viejo mientras la
 * respuesta nueva venía en camino, y el resumen de errores le quitaba el foco para
 * repetirlo. Con la regla, un envío sin nada que corregir deja el resumen vacío, y un
 * resumen vacío no toma el foco.
 *
 * @param answers Cuántas respuestas del servidor ha recibido el formulario.
 * @returns Lo que llevan, y con qué anotar una revisión: lo que encontró, o nulo.
 */
export function useLocalChecks<Found>(answers: number): readonly [LocalChecks<Found>, (found: Found | null) => void] {
  // `after`: cuántas respuestas había cuando se hizo la última revisión.
  const [local, setLocal] = useState<{ found: Found | null; checks: number; after: number | null }>({
    found: null,
    checks: 0,
    after: null,
  });
  const record = (found: Found | null) => setLocal((current) => ({ found, checks: current.checks + 1, after: answers }));
  const latest = local.after === answers;
  return [{ latest, found: latest ? local.found : null, checks: local.checks }, record];
}
