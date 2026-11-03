"use server";

import { refresh } from "next/cache";

import { redirect } from "next/navigation";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { downloadOutcome, readDownloadForm, type DownloadState } from "@/app/_catalog/resources/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { giveCatalogCode } from "@/services/catalog/catalog";
import { clearNotice } from "@/services/account/notice";
import { getMediaGrant, getReviewResourceGrant, getReviewVideoGrant } from "@/services/media/media";
import { approveCourse, approveSubmission, returnCourse } from "@/services/review/review";

import {
  approveOutcome,
  approveSubmissionOutcome,
  NO_RETURN_PROBLEMS,
  readReturnForm,
  readReviewForm,
  returnOutcome,
  returnProblems,
  reviewCodeOutcome,
  reviewVideoAnswerOf,
  videoAnswerOf,
  type CodeState,
  type ReturnState,
  type ReviewState,
  type VideoAnswer,
} from "./outcomes";

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
  const jar = await cookieJar();
  // El aviso con el que se llegó ya se leyó: no vuelve a salir junto a otra respuesta, hablando de otro curso.
  clearNotice(jar);
  if (request.step === "ask") return { kind: "confirming", course: request.course, submission: request.submission ?? null, attempt };

  // Lo enviado por el editor lleva el envío que se vio; un curso por guion, no (T-405).
  const outcome =
    request.submission === undefined
      ? approveOutcome(await approveCourse(jar, { course: request.course }))
      : approveSubmissionOutcome(await approveSubmission(jar, { course: request.course, submission: request.submission }));
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

/**
 * Devolver un curso enviado, en dos pasos. «Devolver» y «Cancelar» no llaman a nadie. Lo que falta o no pasa se dice en su campo, sin llamar al servicio: lo
 * escrito viaja en el estado. Devuelto, se redirige a esta misma página con el aviso; si no, se vuelve a pedir la página, porque la cola pudo cambiar.
 */
export async function returnAction(previous: ReturnState, form: FormData): Promise<ReturnState> {
  const request = readReturnForm(form);
  if (request.step === "none") return { kind: "idle" };
  if (request.step === "cancel") return { kind: "closed", course: request.course };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  clearNotice(jar);
  const { course, submission, reason, whatToFix } = request;
  if (request.step === "ask") return { kind: "open", course, submission, reason, whatToFix, problems: NO_RETURN_PROBLEMS, failure: null, attempt };
  const problems = returnProblems(request);
  if (problems.reason !== null || problems.whatToFix !== null) return { kind: "open", course, submission, reason, whatToFix, problems, failure: null, attempt };

  const outcome = returnOutcome(await returnCourse(jar, { course, submission, reason, whatToFix }));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "open", course, submission, reason, whatToFix, problems, failure: outcome.reason, attempt };
}

/** La dirección firmada de una lección enviada por el editor, con su marca de agua. Lo que llega es el curso y la lección, nunca un playback id. */
export async function reviewVideoAction(courseId: unknown, lessonId: unknown): Promise<VideoAnswer> {
  const jar = await cookieJar();
  const answer = reviewVideoAnswerOf(await getReviewVideoGrant(jar, courseId, lessonId));
  if (answer.kind === "leave") return leaveFor(jar, answer);
  return answer;
}

/** Bajar un recurso de lo enviado, por la puerta de medios. Del formulario solo se lee qué recurso y si hay JavaScript. */
export async function reviewResourceAction(previous: DownloadState, form: FormData): Promise<DownloadState> {
  const request = readDownloadForm(form);
  if (request.kind === "none") return { kind: "idle" };
  const outcome = downloadOutcome(await getReviewResourceGrant(await cookieJar(), request.resource), request.javascript, nextAttempt(previous));
  if (outcome.kind === "redirect") redirect(outcome.url);
  return outcome;
}
