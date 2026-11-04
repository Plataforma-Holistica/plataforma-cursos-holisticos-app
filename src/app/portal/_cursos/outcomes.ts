import { portalCoursePath, portalDeleteCoursePath, portalDiscardVersionPath, portalNewCoursePath, ROUTES } from "@/services/account/navigation";
import type { DraftChange } from "@/services/drafts/editor";

import { changeOutcome, type ChangeFailure, type DraftAnswer, type Leave } from "../_lib/change";
import { textField, type TextProblem } from "../_lib/text";

// Crear y borrar un curso (T-402; PA-42). Es puro: lo que llega del formulario y qué se hace con cada
// respuesta del servicio. Viaja al navegador: no importa nada del servidor.
//
//   · Crear lleva el testigo que la página puso en el formulario. El estado lo devuelve, y el formulario
//     lo usa si viene: «Reintentar» después de «no se supo» no crea otro curso.
//   · Borrar lleva la revisión del contenido que se vio: si otra pestaña cambió el curso, no se borra.
//     Borrado, o si ya no existía (un reenvío), se vuelve a la lista con su aviso: esa ruta ya no tiene
//     curso que pintar.
//   · «Editar» un curso publicado (T-405) abre su versión y vuelve al editor, que ya la pinta; uno cargado por
//     guion no se copia, y se dice. Descartar la versión lleva la revisión del contenido, como borrar.

export { checkDraftText, type TextProblem } from "../_lib/text";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[1-9][0-9]{0,15}$/;
const MAX_INTENT = 120;

export function readNewCourseForm(form: unknown): { title: string; token: string | null } {
  if (!(form instanceof FormData)) return { title: "", token: null };
  const token = textField(form, "token");
  return { title: textField(form, "title"), token: ID.test(token) ? token : null };
}

export type NewCourseState =
  | { kind: "idle" }
  | { kind: "invalid"; problem: TextProblem; title: string; token: string; attempt: number }
  | { kind: "failed"; reason: ChangeFailure; title: string; token: string; attempt: number };

export function createOutcome(result: DraftChange<DraftAnswer>): Leave | { kind: "failed"; reason: ChangeFailure } {
  const outcome = changeOutcome(result, portalNewCoursePath());
  if (outcome.kind === "leave" || outcome.kind === "failed") return outcome;
  const to = outcome.id === null ? null : portalCoursePath(outcome.id);
  return to === null ? { kind: "failed", reason: "unavailable" } : { kind: "leave", to, notice: null, closeSession: false };
}

/** El valor del botón que confirma el borrado. Lo arma la página y lo lee `readDeleteForm`. */
export const deleteButton = (course: string, seen: number) => `delete:${course}:${seen}`;

export function readDeleteForm(form: unknown): { course: string; seen: number } | null {
  if (!(form instanceof FormData)) return null;
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only.length > MAX_INTENT) return null;
  const [verb, course, seen, ...rest] = only.split(":");
  if (verb !== "delete" || rest.length > 0 || course === undefined || !ID.test(course) || seen === undefined || !REVISION.test(seen)) return null;
  const revision = Number(seen);
  return Number.isSafeInteger(revision) ? { course, seen: revision } : null;
}

export type DeleteState = { kind: "idle" } | { kind: "failed"; reason: ChangeFailure; attempt: number };

export function deleteOutcome(result: DraftChange<DraftAnswer>, course: string): Leave | { kind: "failed"; reason: ChangeFailure } {
  if (result.kind === "deleted") return { kind: "leave", to: ROUTES.portalCourses, notice: "course_deleted", closeSession: false };
  if (result.kind === "not_found") return { kind: "leave", to: ROUTES.portalCourses, notice: "course_gone", closeSession: false };
  const outcome = changeOutcome(result, portalDeleteCoursePath(course) ?? ROUTES.portalCourses);
  return outcome.kind === "done" ? { kind: "failed", reason: "unavailable" } : outcome;
}

/** El valor del botón «Editar» de un curso publicado (T-405). */
export const openButton = (course: string) => `open:${course}`;

export function readOpenForm(form: unknown): { course: string } | null {
  if (!(form instanceof FormData)) return null;
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only.length > MAX_INTENT) return null;
  const [verb, course, ...rest] = only.split(":");
  return verb === "open" && rest.length === 0 && course !== undefined && ID.test(course) ? { course } : null;
}

export type OpenFailure = ChangeFailure | "not_copyable";
export type OpenState = { kind: "idle" } | { kind: "failed"; reason: OpenFailure; attempt: number };

export function openOutcome(result: DraftChange<DraftAnswer | "opened" | "open" | "not_copyable">, course: string): Leave | { kind: "failed"; reason: OpenFailure } {
  const editor = portalCoursePath(course) ?? ROUTES.portalCourses;
  switch (result.kind) {
    case "opened":
    case "open":
    // Ya no se edita así (la versión ya se envió, por ejemplo): el editor dice en qué está.
    case "not_editable":
      return { kind: "leave", to: editor, notice: null, closeSession: false };
    case "not_copyable":
      return { kind: "failed", reason: "not_copyable" };
    case "not_found":
      return { kind: "leave", to: ROUTES.portalCourses, notice: "course_gone", closeSession: false };
  }
  // Lo propio de abrir ya contestó arriba: lo que queda es de la lista común.
  const outcome = changeOutcome(result as DraftChange<DraftAnswer>, editor);
  return outcome.kind === "done" ? { kind: "failed", reason: "unavailable" } : outcome;
}

/** El valor del botón que confirma descartar la versión: el curso y la revisión del contenido que se vio. */
export const discardButton = (course: string, seen: number) => `discard:${course}:${seen}`;

export function readDiscardForm(form: unknown): { course: string; seen: number } | null {
  if (!(form instanceof FormData)) return null;
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only.length > MAX_INTENT) return null;
  const [verb, course, seen, ...rest] = only.split(":");
  if (verb !== "discard" || rest.length > 0 || course === undefined || !ID.test(course) || seen === undefined || !REVISION.test(seen)) return null;
  const revision = Number(seen);
  return Number.isSafeInteger(revision) ? { course, seen: revision } : null;
}

export type DiscardState = { kind: "idle" } | { kind: "failed"; reason: ChangeFailure; attempt: number };

export function discardOutcome(result: DraftChange<DraftAnswer | "discarded">, course: string): Leave | { kind: "failed"; reason: ChangeFailure } {
  switch (result.kind) {
    case "discarded":
      return { kind: "leave", to: ROUTES.portalCourses, notice: "version_discarded", closeSession: false };
    case "not_found":
      return { kind: "leave", to: ROUTES.portalCourses, notice: "course_gone", closeSession: false };
    // Ya enviada, ya descartada, o quien descarta ya no puede editar (lo suspendieron mientras confirmaba): el editor dice en qué está. La
    // pantalla de descartar no existe para un suspendido.
    case "not_editable":
    case "suspended":
    case "not_teacher":
      return { kind: "leave", to: portalCoursePath(course) ?? ROUTES.portalCourses, notice: null, closeSession: false };
  }
  // Lo propio de descartar ya contestó arriba: lo que queda es de la lista común.
  const outcome = changeOutcome(result as DraftChange<DraftAnswer>, portalDiscardVersionPath(course) ?? ROUTES.portalCourses);
  return outcome.kind === "done" ? { kind: "failed", reason: "unavailable" } : outcome;
}
