"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { giveCatalogCode } from "@/services/catalog/catalog";
import { getMediaGrant } from "@/services/media/media";
import { approveCourse } from "@/services/review/review";

import { approveOutcome, readReviewForm, reviewCodeOutcome, videoAnswerOf, type CodeState, type ReviewState, type VideoAnswer } from "./outcomes";

// Las acciones de la pantalla de revisión (PA-61 y PA-62 mínimas; FL-45; T-108). Ninguna
// decide quién puede: los servicios corren la guarda, y la base vuelve a comprobar que quien
// aprueba tenga Contenido y un código reciente. Aquí se lee qué se pidió, se llama al servicio
// y se traduce su respuesta con la tabla de la pantalla.

/**
 * Dar el código otra vez, para que aprobar pase su puerta. Es el servicio del catálogo: la
 * misma puerta de Contenido. Un código sin forma no llega al servicio. Verificado, se
 * redirige a esta misma página: recargar no reenvía el código.
 */
export async function reviewCodeAction(previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = reviewCodeOutcome(await giveCatalogCode(jar, code));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * Aprobar un curso, en dos pasos. «Aprobar y publicar» y «Cancelar» no llaman a nadie: el
 * primero solo pregunta en el bloque del curso. Confirmar le pregunta al servicio. Aprobado,
 * se redirige a esta misma página con el aviso (recargar no reenvía); si no, se vuelve a
 * pedir la página: la cola pudo cambiar.
 */
export async function approveAction(previous: ReviewState, form: FormData): Promise<ReviewState> {
  const request = readReviewForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  if (request.step === "ask") return { kind: "confirming", course: request.course, attempt };

  const jar = await cookieJar();
  const outcome = approveOutcome(await approveCourse(jar, { course: request.course }));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * La dirección firmada de una lección, para el reproductor. La pide el navegador después de
 * pintar la página, nunca va en el HTML (RF-305). Firma solo la función única de medios, que
 * corre la guarda: a quien no la pasa se le manda a esta página, donde decide la suya.
 */
export async function lessonVideoAction(lessonId: unknown): Promise<VideoAnswer> {
  const jar = await cookieJar();
  const answer = videoAnswerOf(await getMediaGrant(jar, lessonId, "review"));
  if (answer.kind === "leave") return leaveFor(jar, answer);
  return answer;
}
