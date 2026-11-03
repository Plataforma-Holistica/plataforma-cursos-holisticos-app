import { ROUTES } from "@/services/account/navigation";
import type { CourseSubmitted } from "@/services/drafts/editor";

import { changeOutcome, type Leave } from "../_lib/change";

// Enviar a revisión (PA-44; FL-34; T-405). Es puro: qué llega del formulario y qué se hace con cada respuesta del servicio. Viaja al navegador: no importa nada del servidor.
//
//   · El botón lleva todo lo que se vio: el curso, el anexo, la huella, el plazo y el número de envío. La base compara, y si algo cambió contesta `changed`: nunca se firma lo que no
//     se vio. La casilla viaja aparte: es lo único que pone el maestro.
//   · Enviado, a Mis cursos con el aviso: recargar no reenvía. Un curso que dejó de ser borrador (otra pestaña lo envió) también va ahí, que dice en qué está.

export const ACCEPT_FIELD = "acepto";
/** Lo que manda una casilla marcada, sin `value`: el componente de consentimiento no pone otro. */
export const ACCEPT_VALUE = "on";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const COUNT = /^[1-9][0-9]{0,8}$/;
const REVISION = /^[1-9][0-9]{0,15}$/;
const MAX_INTENT = 240;

export type SubmitRequest =
  | { step: "none" }
  | { step: "submit"; course: string; annex: string; seen: string; term: number; submission: number; accepted: boolean }
  | { step: "remove"; course: string; resource: string; seen: number };

export const submitButton = (input: { course: string; annex: string; seen: string; term: number; submission: number }) =>
  `submit:${input.course}:${input.annex}:${input.seen}:${input.term}:${input.submission}`;
export const removePendingButton = (course: string, resource: string, revision: number) => `remove:${course}:${resource}:${revision}`;

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readSubmitForm(form: unknown): SubmitRequest {
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, ...parts] = only.split(":");
  if (verb === "submit" && parts.length === 5) {
    const [course = "", annex = "", seen = "", term = "", submission = ""] = parts;
    if (!ID.test(course) || !ID.test(annex) || !HASH.test(seen) || !COUNT.test(term) || !COUNT.test(submission)) return { step: "none" };
    const accepted = form.getAll(ACCEPT_FIELD);
    return { step: "submit", course, annex, seen, term: Number(term), submission: Number(submission), accepted: accepted.length === 1 && accepted[0] === ACCEPT_VALUE };
  }
  if (verb === "remove" && parts.length === 3) {
    const [course = "", resource = "", seen = ""] = parts;
    if (!ID.test(course) || !ID.test(resource) || !REVISION.test(seen)) return { step: "none" };
    return { step: "remove", course, resource, seen: Number(seen) };
  }
  return { step: "none" };
}

/** Lo que contestó quitar un recurso pendiente. */
export type RemoveFailure = "remove_changed" | "remove_unavailable" | "remove_unknown";

export type SubmitFailure =
  | "not_accepted"
  | "changed"
  | "not_ready"
  | "annex_missing"
  | "video_not_ready"
  | "origin_missing"
  | "unavailable"
  | "unknown";

export type SubmitState =
  | { kind: "idle" }
  /** Quitado: se dice, y el foco lo toma el aviso, porque el botón se fue con su fila. */
  | { kind: "removed"; attempt: number }
  /** `lessons`: las de un video que su proveedor ya no tiene listo. */
  | { kind: "failed"; reason: SubmitFailure | RemoveFailure; lessons: string[]; attempt: number };

export type SubmitOutcome = Leave | { kind: "failed"; reason: SubmitFailure; lessons: string[] };

const leave = (to: string, notice: Leave["notice"] = null): Leave => ({ kind: "leave", to, notice, closeSession: false });

/**
 * Lo que contestó enviar.
 * @param back Esta misma ruta, ya armada.
 */
export function submitOutcome(result: CourseSubmitted, back: string): SubmitOutcome {
  switch (result.kind) {
    case "submitted":
      return leave(ROUTES.portalCourses, "course_submitted");
    case "not_editable":
      return leave(ROUTES.portalCourses);
    case "not_found":
      return leave(ROUTES.portalCourses, "course_gone");
    case "suspended":
    case "not_teacher":
      // La guarda de esta misma ruta dice qué pasa.
      return leave(back);
    case "video_not_ready":
      return { kind: "failed", reason: "video_not_ready", lessons: result.lessons };
    case "not_accepted":
    case "changed":
    case "not_ready":
    case "annex_missing":
    case "origin_missing":
    case "unavailable":
    case "unknown":
      return { kind: "failed", reason: result.kind, lessons: [] };
    case "invalid":
    case "malformed":
      // Solo con un formulario armado a mano: la página de ahora lo aclara.
      return { kind: "failed", reason: "changed", lessons: [] };
    case "session": {
      // Las mismas salidas que cualquier cambio al borrador.
      const outcome = changeOutcome(result, back);
      return outcome.kind === "leave" ? outcome : { kind: "failed", reason: "unavailable", lessons: [] };
    }
  }
}
