"use server";

import { refresh } from "next/cache";

import { cookieJar } from "@/app/_lib/request-context";
import { changeName } from "@/services/account/account";

import { leaveFor } from "../_lib/exit";
import { nextAttempt } from "../_lib/form-state";

import { changeNameOutcome, readNameForm, type NameState } from "./outcomes";

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
