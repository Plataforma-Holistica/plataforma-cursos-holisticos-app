"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import type { CookieJar } from "@/services/account/account";
import { removeCourse, saveCourse } from "@/services/browse/browse";

import { listOutcome, readListForm, type ListOutcome, type ListState } from "./outcomes";

// Guardar y quitar de Mi lista (RF-311; FL-11 paso 6; T-210). Una acción por pantalla, porque
// cada una vuelve a la suya: la ficha del curso, el inicio y explorar. Del formulario solo se lee
// qué botón se pulsó (guardar o quitar, y qué curso); el servicio corre la guarda de sesión y
// escribe a nombre de esa sesión. Del estado anterior solo se lee el número de intento.
//
// Sin JavaScript, el formulario vuelve a la misma pantalla en el mismo lugar (el tercer argumento
// de `useActionState`), y Next la pinta otra vez con la lista nueva. Con JavaScript, `refresh()`.

/** Lo que sigue a la respuesta: salir hacia otra pantalla, o pintarla en esta. */
async function settle(jar: CookieJar, outcome: ListOutcome, slug: string, attempt: number): Promise<ListState> {
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);
  // Lo que pinta la página cambió, o pudo cambiar: también con «ya no está» y «no se supo».
  refresh();
  return { kind: outcome.kind, slug, attempt };
}

/** El botón de la ficha del curso (PA-02). */
export async function courseListAction(previous: ListState, form: FormData): Promise<ListState> {
  const request = readListForm(form);
  if (request.kind === "none") return { kind: "idle" };
  const jar = await cookieJar();
  const result = request.kind === "save" ? await saveCourse(jar, request.slug) : await removeCourse(jar, request.slug);
  return settle(jar, listOutcome("course", request.slug, result), request.slug, nextAttempt(previous));
}

/** «Quitar» en el carrusel «Mi lista» del inicio (PA-20). */
export async function homeListAction(previous: ListState, form: FormData): Promise<ListState> {
  const request = readListForm(form);
  if (request.kind === "none") return { kind: "idle" };
  const jar = await cookieJar();
  const result = request.kind === "save" ? await saveCourse(jar, request.slug) : await removeCourse(jar, request.slug);
  return settle(jar, listOutcome("home", request.slug, result), request.slug, nextAttempt(previous));
}

/** El botón bajo cada tarjeta de explorar (PA-21). */
export async function exploreListAction(previous: ListState, form: FormData): Promise<ListState> {
  const request = readListForm(form);
  if (request.kind === "none") return { kind: "idle" };
  const jar = await cookieJar();
  const result = request.kind === "save" ? await saveCourse(jar, request.slug) : await removeCourse(jar, request.slug);
  return settle(jar, listOutcome("explore", request.slug, result), request.slug, nextAttempt(previous));
}
