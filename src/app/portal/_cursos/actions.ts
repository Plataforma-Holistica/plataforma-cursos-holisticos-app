"use server";

import { randomUUID } from "node:crypto";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import { createCourse, deleteCourse, discardVersion, openVersion } from "@/services/drafts/editor";

import {
  checkDraftText,
  createOutcome,
  deleteOutcome,
  discardOutcome,
  openOutcome,
  readDeleteForm,
  readDiscardForm,
  readNewCourseForm,
  readOpenForm,
  type DeleteState,
  type DiscardState,
  type NewCourseState,
  type OpenState,
} from "./outcomes";

// Crear y borrar un curso (T-402; PA-42), y abrir o descartar la versión de uno publicado (T-405). Ninguna decide quién puede: el servicio corre la guarda y la
// base escribe solo a nombre del maestro activo. Del estado anterior solo se lee el número de intento.

/**
 * Crear un curso con su título. Un título sin forma no llega al servicio. Creado, se va al editor; si
 * no, el estado devuelve lo escrito y el testigo, para que reintentar no cree otro.
 */
export async function createCourseAction(previous: NewCourseState, form: FormData): Promise<NewCourseState> {
  const request = readNewCourseForm(form);
  const attempt = nextAttempt(previous);
  // Un testigo sin forma es un formulario alterado: no se crea nada, y el formulario recibe uno nuevo.
  const token = request.token ?? randomUUID();
  if (request.token === null) return { kind: "failed", reason: "unavailable", title: request.title, token, attempt };
  const problem = checkDraftText("courseTitle", request.title);
  if (problem) return { kind: "invalid", problem, title: request.title, token, attempt };

  const jar = await cookieJar();
  const outcome = createOutcome(await createCourse(jar, { token, title: request.title }));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, title: request.title, token, attempt };
}

/** Borrar un curso que nunca se envió, con la revisión del contenido que se vio. */
export async function deleteCourseAction(previous: DeleteState, form: FormData): Promise<DeleteState> {
  const request = readDeleteForm(form);
  if (request === null) return { kind: "idle" };
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const outcome = deleteOutcome(await deleteCourse(jar, { course: request.course, seen: request.seen }), request.course);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "failed", reason: outcome.reason, attempt };
}

/** «Editar» un curso publicado (T-405, FL-36): abre su versión, o la que ya estaba, y vuelve al editor. */
export async function openVersionAction(previous: OpenState, form: FormData): Promise<OpenState> {
  const request = readOpenForm(form);
  if (request === null) return { kind: "idle" };
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const outcome = openOutcome(await openVersion(jar, { course: request.course }), request.course);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/** Descartar la versión de un curso publicado (H-18), con la revisión del contenido que se vio. */
export async function discardVersionAction(previous: DiscardState, form: FormData): Promise<DiscardState> {
  const request = readDiscardForm(form);
  if (request === null) return { kind: "idle" };
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const outcome = discardOutcome(await discardVersion(jar, { course: request.course, seen: request.seen }), request.course);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "failed", reason: outcome.reason, attempt };
}
