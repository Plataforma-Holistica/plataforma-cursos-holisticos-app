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
