import "server-only";

import { notFound, redirect } from "next/navigation";

import { checkSession, teamStanding } from "@/services/account/account";
import type { Capability } from "@/services/account/team";

import {
  adminPageStep,
  consentsPageStep,
  factorSetupPageStep,
  lessonPageStep,
  publicPageStep,
  secondFactorPageStep,
  sessionPageStep,
  visitorPageStep,
} from "./guard-steps";
import { cookieReader } from "./request-context";

// La guarda de sesión, para una página (flujo de la app §6.2; TRD §9.3). Toda página que
// no sea pública llama a una de estas funciones antes de pintar nada, y una prueba de
// arquitectura lo exige: el paso previo solo mira si hay cookie.
//
// Aquí no se decide quién pasa: se le pregunta al servicio (`checkSession`, o `teamStanding`
// para las pantallas del equipo) y se obedece. Lo que no es redirigir se le devuelve a la
// página, que pinta la pantalla o el estado.

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

/**
 * Para la pantalla de una lección (PA-22, T-203): como `requireSession`, salvo a dónde va
 * quien llega sin sesión. Si el curso es el abierto, a registrarse; si no, a entrar.
 * @param courseIsOpen Se pregunta solo cuando no hay sesión: es una lectura de más.
 */
export async function requireLessonSession(path: string, courseIsOpen: () => Promise<boolean | null>) {
  const check = await checkSession(await cookieReader());
  const step = lessonPageStep(check, path, check.kind === "anonymous" ? await courseIsOpen() : null);
  if (step.kind === "redirect") redirect(step.to);
  return step;
}

/** Para la pantalla que pide lo que le falta a la cuenta (PA-15). */
export async function requireIncompleteSession(returnTo: string | null | undefined) {
  const step = consentsPageStep(await checkSession(await cookieReader()), returnTo);
  if (step.kind === "redirect") redirect(step.to);
  return step;
}

/**
 * Para una pantalla pública que cambia según quién mira (PA-02, T-210): nunca redirige. Dice si
 * mira un alumno con sesión que pasa (con sus claims), un visitante, o alguien de quien no se
 * sabe (`publicPageStep`).
 */
export async function publicViewer() {
  return publicPageStep(await checkSession(await cookieReader()));
}

/** Para una pantalla de visitante: quien ya tiene sesión se va a su inicio. */
export async function visitorOnly(): Promise<void> {
  const step = visitorPageStep(await checkSession(await cookieReader()));
  if (step.kind === "redirect") redirect(step.to);
}

/**
 * Para una pantalla de administración. Quién es del equipo lo dice la base, por
 * `teamStanding`: el nivel que diga el token no cuenta. A quien no es del equipo le contesta
 * lo mismo que una ruta que no existe (PA-19).
 * @param path La ruta que se pidió: es a donde se vuelve después de entrar y de dar el código.
 * @param capability La capacidad que esa pantalla pide, si pide una (PA-88).
 */
export async function requireAdmin(path: string, capability?: Capability) {
  const step = adminPageStep(await teamStanding(await cookieReader()), path, capability);
  if (step.kind === "redirect") redirect(step.to);
  if (step.kind === "not_found") notFound();
  return step;
}

/** Para la pantalla que pide el código del segundo factor (PA-12). */
export async function requireSecondFactor(returnTo: string | null | undefined) {
  const step = secondFactorPageStep(await teamStanding(await cookieReader()), returnTo);
  if (step.kind === "redirect") redirect(step.to);
  if (step.kind === "not_found") notFound();
  return step;
}

/** Para la pantalla en la que se configura el segundo factor, que es aceptar una invitación (PA-12). */
export async function requireFactorSetup() {
  const step = factorSetupPageStep(await teamStanding(await cookieReader()));
  if (step.kind === "redirect") redirect(step.to);
  if (step.kind === "not_found") notFound();
  return step;
}
