"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import { portalCoursePath, ROUTES } from "@/services/account/navigation";
import { beginResource, confirmResource, moveResource, removeResource } from "@/services/drafts/editor";

import { changeOutcome } from "../_lib/change";
import { readResourceForm, type BeginStep, type ConfirmStep, type ResourceState, type UploadProblem } from "./resource-outcomes";

// Las acciones de los recursos en el editor de curso (PA-43; T-404). No deciden quién puede: el servicio corre la
// guarda y la base escribe solo a nombre del maestro activo.
//
// Subir es del navegador a la cubeta, porque Vercel corta todo envío a una función en 4.5 MB: empezar reserva la fila
// y contesta la dirección firmada; el navegador sube; confirmar le pregunta a la base. Las dos reciben lo que arma
// quien pide, y puede no ser lo que este código armó: lo que no sea un texto cuenta como vacío.

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");
/** Lo que llega lo arma quien pide: puede no ser un objeto. */
const fieldsOf = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});
const lessonOf = (value: unknown): string | null => (value === null || value === undefined ? null : textOf(value));
const backOf = (course: string, lesson: string | null) => portalCoursePath(course, lesson === null ? {} : { lesson }) ?? ROUTES.portalCourses;

/** La lista: mover y quitar. Del estado anterior solo se lee el número de intento. */
export async function resourceAction(previous: ResourceState, form: FormData): Promise<ResourceState> {
  const request = readResourceForm(form);
  if (request.step === "none") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  // Preguntar antes de quitar, y cancelar, no llaman a nadie.
  if (request.step === "cancel") return { kind: "kept", attempt };
  if (request.step === "ask") return { kind: "confirming", resource: request.resource, attempt };

  const jar = await cookieJar();
  const { course, resource } = request;
  const result =
    request.step === "move"
      ? await moveResource(jar, { course, resource, seenPosition: request.seen, toPosition: request.to })
      : await removeResource(jar, { course, resource, seen: request.seen });
  const outcome = changeOutcome(result, backOf(course, request.lesson));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  if (outcome.kind === "done") return { kind: "done", what: outcome.answer === "moved" ? "moved" : "removed", attempt };
  return { kind: "failed", reason: outcome.reason, attempt };
}

const BEGIN_PROBLEMS: Readonly<Record<string, UploadProblem>> = {
  invalid: "unavailable",
  too_large: "fileSize",
  too_many: "tooMany",
  throttled: "throttled",
  unavailable: "unavailable",
  unknown: "unavailable",
  not_found: "gone",
};

/** Empezar: reserva la fila y contesta la dirección firmada. El tipo lo fija el servidor por el nombre del archivo. */
export async function beginResourceAction(input: { course: string; lesson: string | null; title: string; fileName: string; size: number }): Promise<BeginStep> {
  const fields = fieldsOf(input);
  const course = textOf(fields.course);
  const lesson = lessonOf(fields.lesson);
  const size = typeof fields.size === "number" ? fields.size : 0;
  const jar = await cookieJar();
  const result = await beginResource(jar, { course, lesson, title: textOf(fields.title), fileName: textOf(fields.fileName), size });
  if (result.kind === "started") return { kind: "go", resource: result.resource, url: result.url, mime: result.mime };
  if (result.kind === "session") {
    const outcome = changeOutcome(result, backOf(course, lesson));
    if (outcome.kind === "leave") return leaveFor(jar, outcome);
    return { kind: "problem", problem: "unavailable" };
  }
  // Quien ya no puede editar vuelve a la misma ruta: ahí la guarda y la página dicen qué pasa.
  if (result.kind === "suspended" || result.kind === "not_teacher" || result.kind === "not_editable") {
    return leaveFor(jar, { to: backOf(course, lesson), notice: null });
  }
  // La lista pudo cambiar: el lugar se llenó, o lo elegido ya no está.
  if (result.kind === "too_many" || result.kind === "not_found") refresh();
  return { kind: "problem", problem: BEGIN_PROBLEMS[result.kind] ?? "unavailable" };
}

const CONFIRM_PROBLEMS: Readonly<Record<string, UploadProblem>> = {
  invalid: "unavailable",
  expired: "expired",
  not_uploaded: "notUploaded",
  unavailable: "unavailable",
  unknown: "unavailable",
  not_found: "gone",
};

const REJECTED: Readonly<Record<string, UploadProblem>> = { type: "rejectedType", size: "rejectedSize", content: "rejectedContent" };

/** Confirmar: lee el contenido del objeto y le pregunta a la base. Vuelve a leer el borrador con lo que haya cambiado. */
export async function confirmResourceAction(input: { course: string; lesson: string | null; resource: string }): Promise<ConfirmStep> {
  const fields = fieldsOf(input);
  const course = textOf(fields.course);
  const lesson = lessonOf(fields.lesson);
  const jar = await cookieJar();
  const result = await confirmResource(jar, { course, resource: textOf(fields.resource) });
  if (result.kind === "ready") {
    refresh();
    return { kind: "ready" };
  }
  if (result.kind === "rejected") return { kind: "problem", problem: (result.reason !== null && REJECTED[result.reason]) || "rejectedContent" };
  if (result.kind === "session") {
    const outcome = changeOutcome(result, backOf(course, lesson));
    if (outcome.kind === "leave") return leaveFor(jar, outcome);
    return { kind: "problem", problem: "unavailable" };
  }
  // Quien ya no puede editar vuelve a la misma ruta: ahí la guarda y la página dicen qué pasa.
  if (result.kind === "suspended" || result.kind === "not_teacher" || result.kind === "not_editable") {
    return leaveFor(jar, { to: backOf(course, lesson), notice: null });
  }
  if (result.kind === "not_found") refresh();
  return { kind: "problem", problem: CONFIRM_PROBLEMS[result.kind] ?? "unavailable" };
}

/** La subida no llegó a la cubeta: se cancela la fila, que acaba de nacer, para que no ocupe lugar 3 horas. */
export async function cancelResourceAction(input: { course: string; resource: string }): Promise<void> {
  const fields = fieldsOf(input);
  const jar = await cookieJar();
  await removeResource(jar, { course: textOf(fields.course), resource: textOf(fields.resource), seen: 1 });
}
