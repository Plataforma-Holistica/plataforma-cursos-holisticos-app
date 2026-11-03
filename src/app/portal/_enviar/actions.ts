"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { portalCoursePath, ROUTES } from "@/services/account/navigation";
import { removeResource, submitCourse } from "@/services/drafts/editor";

import { changeOutcome } from "../_lib/change";
import { readSubmitForm, submitOutcome, type SubmitState } from "./outcomes";

// Las acciones de PA-44 (FL-34; T-405). Ninguna decide quién puede: el servicio corre la guarda, y la base exige al maestro activo y compara lo que se vio. Aquí se lee qué se pidió,
// se llama al servicio y se traduce su respuesta con la tabla de la pantalla. Del estado anterior solo se lee el número de intento.

/** Enviar, o quitar un recurso a medio subir que impide enviar. Lo que no se hizo se dice, y la página se vuelve a pedir: el curso pudo cambiar. */
export async function submitCourseAction(previous: SubmitState, form: FormData): Promise<SubmitState> {
  const request = readSubmitForm(form);
  if (request.step === "none") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  const back = `${portalCoursePath(request.course) ?? ROUTES.portalCourses}/enviar`;

  if (request.step === "remove") {
    const outcome = changeOutcome(await removeResource(jar, { course: request.course, resource: request.resource, seen: request.seen }), back);
    if (outcome.kind === "leave") return leaveFor(jar, outcome);
    refresh();
    return outcome.kind === "done" ? { kind: "idle" } : { kind: "failed", reason: outcome.reason === "changed" ? "changed" : "unavailable", attempt };
  }

  const { course, annex, seen, term, submission, accepted } = request;
  const outcome = submitOutcome(await submitCourse(jar, { course, annex, seen, term, submission, accepted }, await requestOrigin()), back);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  if (outcome.reason !== "not_accepted") refresh();
  return { kind: "failed", reason: outcome.reason, attempt };
}
