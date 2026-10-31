"use server";

import { redirect } from "next/navigation";

import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import { getResourceGrant } from "@/services/media/media";

import { downloadOutcome, readDownloadForm, type DownloadState } from "./outcomes";

// Bajar un recurso (RF-308; FL-14; T-404), en la ficha del curso y en la lección. Del formulario solo se lee qué recurso y si
// hay JavaScript; la puerta de medios corre la guarda de sesión, decide y firma. Del estado anterior solo se lee el número de
// intento. No escribe nada que la página pinte, así que no la vuelve a pedir.

export async function downloadResourceAction(previous: DownloadState, form: FormData): Promise<DownloadState> {
  const request = readDownloadForm(form);
  if (request.kind === "none") return { kind: "idle" };
  const outcome = downloadOutcome(await getResourceGrant(await cookieJar(), request.resource), request.javascript, nextAttempt(previous));
  if (outcome.kind === "redirect") redirect(outcome.url);
  return outcome;
}
