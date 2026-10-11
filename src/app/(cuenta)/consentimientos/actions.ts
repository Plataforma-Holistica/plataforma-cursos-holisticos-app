"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { completeAccount, signOut } from "@/services/account/account";
import { leaveNotice } from "@/services/account/notice";

import { nextAttempt } from "../_lib/form-state";

import { completeAccountOutcome, readConsentsForm, type ConsentsState } from "./outcomes";

/**
 * Lo que envía la pantalla que pide lo que le falta a una cuenta (diseño, PA-15). El
 * servicio vuelve a correr la guarda de sesión: solo escribe para una sesión reconocida a
 * la que de verdad le falte algo, y solo lo que le falta. Aquí se traduce su respuesta.
 *
 * Del estado anterior solo se lee el número de intento.
 */
export async function completeAccountAction(previous: ConsentsState, form: FormData): Promise<ConsentsState> {
  const input = readConsentsForm(form);
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const result = await completeAccount(
    jar,
    { name: input.name, adultDeclared: input.adult, accepted: input.accepted },
    await requestOrigin(),
  );
  const outcome = completeAccountOutcome(result, input.returnTo, input.unchecked);

  if (outcome.kind === "redirect") {
    // La guarda dijo que esta sesión ya no vale: se cierra antes de irse.
    if (outcome.closeSession) await signOut(jar);
    if (outcome.notice) leaveNotice(jar, outcome.notice);
    redirect(outcome.to);
  }

  switch (outcome.kind) {
    case "repaint":
      // La página se vuelve a pedir: llega con lo que falte ahora y con los textos vigentes.
      // Sin esto, con JavaScript la pantalla se quedaría con los textos de antes.
      refresh();
      return { kind: "repainted", reason: outcome.reason, name: input.name, attempt };
    case "invalid":
      return { kind: "invalid", name: input.name, fields: outcome.fields, attempt };
    case "suspended":
      return { kind: "suspended" };
    case "unavailable":
      return { kind: "unavailable", name: input.name, attempt };
  }
}
