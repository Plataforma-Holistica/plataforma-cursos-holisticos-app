"use server";

import { refresh } from "next/cache";

import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { changeName, changePassword, closeOtherSessions, closeSession } from "@/services/account/account";

import { leaveFor } from "../_lib/exit";
import { nextAttempt } from "../_lib/form-state";

import {
  changeNameOutcome,
  changePasswordOutcome,
  closeOthersOutcome,
  closeSessionOutcome,
  readNameForm,
  readPasswordForm,
  readSessionsForm,
  type NameState,
  type PasswordState,
  type SessionsState,
} from "./outcomes";

/**
 * Lo que envía el bloque del nombre de la pantalla de la cuenta (diseño, PA-25). El servicio
 * vuelve a correr la guarda de sesión y guarda en la cuenta de esa sesión: del formulario
 * solo se lee el nombre. Aquí se traduce su respuesta.
 *
 * Del estado anterior solo se lee el número de intento.
 */
export async function changeNameAction(previous: NameState, form: FormData): Promise<NameState> {
  const input = readNameForm(form);
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const outcome = changeNameOutcome(await changeName(jar, { name: input.name }));

  // Si la guarda dijo que esta sesión ya no vale, se cierra antes de irse.
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);

  switch (outcome.kind) {
    case "saved":
      // La página se vuelve a pedir: lo que pinta del servidor queda con el nombre nuevo.
      refresh();
      return { kind: "saved", name: outcome.name, attempt };
    case "invalid":
      return { kind: "invalid", name: input.name, problem: outcome.problem, attempt };
    case "suspended":
      return { kind: "suspended" };
    case "unavailable":
      return { kind: "unavailable", name: input.name, attempt };
  }
}

/**
 * Lo que envía el bloque de las sesiones abiertas (diseño, PA-25): cerrar una, o todas las
 * demás. Del formulario solo se lee qué botón se pulsó. El servicio vuelve a correr la
 * guarda, busca la sesión entre las de quien envía, y la que se queda es la de esta petición.
 *
 * Del estado anterior solo se lee el número de intento.
 */
export async function closeSessionsAction(previous: SessionsState, form: FormData): Promise<SessionsState> {
  const request = readSessionsForm(form);
  // Sin saber qué se quiere cerrar no se le pregunta nada a nadie.
  if (request.target === "none") return { kind: "idle" };
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const outcome =
    request.target === "others"
      ? closeOthersOutcome(await closeOtherSessions(jar))
      : closeSessionOutcome(await closeSession(jar, { sessionId: request.sessionId }));

  // Si la guarda dijo que esta sesión ya no vale, se cierra antes de irse.
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);

  switch (outcome.kind) {
    case "closed":
      // La página se vuelve a pedir: la lista que pinta ya no trae lo que se cerró.
      refresh();
      return { kind: "closed", what: outcome.what, attempt };
    case "suspended":
      return { kind: "suspended" };
    case "unavailable":
      return { kind: "unavailable", attempt };
  }
}

/**
 * Lo que envía el bloque de la contraseña (diseño, PA-25). Del formulario solo se leen la
 * contraseña actual y la nueva. El servicio vuelve a correr la guarda, comprueba la actual
 * por el mismo freno de intentos que la pantalla de entrar, y cambia la de la cuenta de esa
 * sesión: por eso recibe de dónde viene la petición.
 *
 * Del estado anterior solo se lee el número de intento. Una contraseña nunca vuelve en la
 * respuesta.
 */
export async function changePasswordAction(previous: PasswordState, form: FormData): Promise<PasswordState> {
  const input = readPasswordForm(form);
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const outcome = changePasswordOutcome(await changePassword(jar, input, await requestOrigin()));

  // Si la guarda dijo que esta sesión ya no vale, se cierra antes de irse. Si fue el cambio
  // el que dejó a este navegador sin sesión, ya no hay nada que cerrar: solo irse a entrar.
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);

  switch (outcome.kind) {
    case "changed":
      // La página se vuelve a pedir: la sesión de este navegador ya es otra, y las demás se cerraron.
      refresh();
      return { kind: "changed", attempt };
    case "invalid":
      return { kind: "invalid", fields: outcome.fields, attempt };
    case "throttled":
      return { kind: "throttled", retryAt: outcome.retryAt, attempt };
    case "capped":
      return { kind: "failed", reason: "capped", attempt };
    case "recover_only":
      return { kind: "recover_only" };
    case "suspended":
      return { kind: "suspended" };
    case "unavailable":
      return { kind: "failed", reason: "unavailable", attempt };
  }
}
