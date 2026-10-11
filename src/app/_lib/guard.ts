import "server-only";

import { redirect } from "next/navigation";

import { checkSession } from "@/services/account/account";

import { consentsPageStep, sessionPageStep, visitorPageStep } from "./guard-steps";
import { cookieReader } from "./request-context";

// La guarda de sesión, para una página (flujo de la app §6.2; TRD §9.3). Toda página que
// no sea pública llama a una de estas tres funciones antes de pintar nada, y una prueba de
// arquitectura lo exige: el paso previo solo mira si hay cookie.
//
// Aquí no se decide quién pasa: se le pregunta al servicio (`checkSession`) y se obedece.
// Lo que no es redirigir se le devuelve a la página, que pinta la pantalla o el estado.

/**
 * Para una pantalla con sesión. Redirige a entrar, a completar la cuenta o a cerrar una
 * sesión que ya no vale; si no, devuelve qué pintar.
 * @param path La ruta de esa pantalla: es a donde se vuelve después de entrar.
 */
export async function requireSession(path: string) {
  const step = sessionPageStep(await checkSession(await cookieReader()), path);
  if (step.kind === "redirect") redirect(step.to);
  return step;
}

/** Para la pantalla que pide lo que le falta a la cuenta (PA-15). */
export async function requireIncompleteSession(returnTo: string | null | undefined) {
  const step = consentsPageStep(await checkSession(await cookieReader()), returnTo);
  if (step.kind === "redirect") redirect(step.to);
  return step;
}

/** Para una pantalla de visitante: quien ya tiene sesión se va a su inicio. */
export async function visitorOnly(): Promise<void> {
  const step = visitorPageStep(await checkSession(await cookieReader()));
  if (step.kind === "redirect") redirect(step.to);
}
