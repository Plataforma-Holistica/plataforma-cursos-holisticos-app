"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { cookieJar } from "@/app/_lib/request-context";
import { portalCoursePath, ROUTES } from "@/services/account/navigation";
import { beginVideo, checkVideos, confirmVideo, removeVideo, renewVideoUpload } from "@/services/drafts/editor";

import { changeOutcome } from "../_lib/change";
import {
  VIDEO_BEGIN_PROBLEMS,
  VIDEO_CONFIRM_PROBLEMS,
  VIDEO_REJECTED,
  type VideoBeginStep,
  type VideoCheckStep,
  type VideoConfirmStep,
  type VideoRemoveStep,
  type VideoRenewStep,
} from "./video-outcomes";

// Las acciones del video de una lección en el editor (PA-43; T-403). No deciden quién puede: el servicio corre la guarda y la base
// escribe solo a nombre del maestro activo. Lo que llega lo arma quien pide, y puede no ser lo que este código armó: lo que no sea
// un texto cuenta como vacío.

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");
/** Lo que llega lo arma quien pide: puede no ser un objeto. */
const fieldsOf = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});
const backOf = (course: string, lesson: string) => portalCoursePath(course, lesson === "" ? {} : { lesson }) ?? ROUTES.portalCourses;

/** Quien ya no puede editar vuelve a la misma ruta: ahí la guarda y la página dicen qué pasa. */
const LEAVES: readonly string[] = ["suspended", "not_teacher", "not_editable"];

/** Empezar: reserva la fila o encuentra la que estaba a medias, y contesta a dónde subir. El tipo lo fija el servidor por el nombre. */
export async function beginVideoAction(input: { course: string; lesson: string; fileName: string; size: number }): Promise<VideoBeginStep> {
  const fields = fieldsOf(input);
  const course = textOf(fields.course);
  const lesson = textOf(fields.lesson);
  const size = typeof fields.size === "number" ? fields.size : 0;
  const jar = await cookieJar();
  const result = await beginVideo(jar, { course, lesson, fileName: textOf(fields.fileName), size });
  if (result.kind === "go") {
    const { video, path, mime, bucket, endpoint, token, resumed } = result;
    refresh();
    return { kind: "go", target: { video, path, mime, bucket, endpoint }, token, resumed };
  }
  if (result.kind === "pending") return { kind: "pending", fileName: result.fileName };
  if (result.kind === "session") {
    const outcome = changeOutcome(result, backOf(course, lesson));
    if (outcome.kind === "leave") return leaveFor(jar, outcome);
    return { kind: "problem", problem: "unavailable" };
  }
  if (LEAVES.includes(result.kind)) return leaveFor(jar, { to: backOf(course, lesson), notice: null });
  if (result.kind === "not_found" || result.kind === "busy") refresh();
  return { kind: "problem", problem: VIDEO_BEGIN_PROBLEMS[result.kind] ?? "unavailable" };
}

/** Otra firma para seguir subiendo. Vuelve a preguntar por el maestro y por la fila. */
export async function renewVideoAction(input: { course: string; lesson: string; video: string }): Promise<VideoRenewStep> {
  const fields = fieldsOf(input);
  const course = textOf(fields.course);
  const lesson = textOf(fields.lesson);
  const jar = await cookieJar();
  const result = await renewVideoUpload(jar, { course, video: textOf(fields.video) });
  if (result.kind === "renewed") return { kind: "renewed", token: result.token };
  if (result.kind === "session") {
    const outcome = changeOutcome(result, backOf(course, lesson));
    if (outcome.kind === "leave") return leaveFor(jar, outcome);
    return { kind: "problem", problem: "unavailable" };
  }
  if (LEAVES.includes(result.kind)) return leaveFor(jar, { to: backOf(course, lesson), notice: null });
  if (result.kind === "not_found") refresh();
  return { kind: "problem", problem: result.kind === "not_found" ? "gone" : "unavailable" };
}

/** Confirmar: lee el archivo y le pregunta a la base. */
export async function confirmVideoAction(input: { course: string; lesson: string; video: string }): Promise<VideoConfirmStep> {
  const fields = fieldsOf(input);
  const course = textOf(fields.course);
  const lesson = textOf(fields.lesson);
  const jar = await cookieJar();
  const result = await confirmVideo(jar, { course, video: textOf(fields.video) });
  if (result.kind === "uploaded") {
    refresh();
    return { kind: "uploaded" };
  }
  if (result.kind === "rejected") {
    refresh();
    return { kind: "problem", problem: (result.reason !== null && VIDEO_REJECTED[result.reason]) || "rejectedContent" };
  }
  if (result.kind === "session") {
    const outcome = changeOutcome(result, backOf(course, lesson));
    if (outcome.kind === "leave") return leaveFor(jar, outcome);
    return { kind: "problem", problem: "unavailable" };
  }
  if (LEAVES.includes(result.kind)) return leaveFor(jar, { to: backOf(course, lesson), notice: null });
  if (result.kind === "not_found" || result.kind === "expired") refresh();
  return { kind: "problem", problem: VIDEO_CONFIRM_PROBLEMS[result.kind] ?? "unavailable" };
}

/**
 * Lo que el editor pregunta solo, al cargar y mientras haya algo en camino: procesa lo recibido y asienta lo que diga el proveedor. Nadie pidió
 * esto, así que nunca saca a nadie de la pantalla: una sesión vencida la dirá lo siguiente que la persona haga, con lo que estaba escribiendo a salvo.
 */
export async function checkVideosAction(input: { course: string }): Promise<VideoCheckStep> {
  const jar = await cookieJar();
  const result = await checkVideos(jar, { course: textOf(fieldsOf(input).course) });
  if (result.kind !== "checked") return { blocked: {} };
  if (result.changed) refresh();
  return { blocked: result.blocked };
}

/** Cancelar una subida o quitar un video que nunca se publicó. */
export async function removeVideoAction(input: { course: string; lesson: string; video: string }): Promise<VideoRemoveStep> {
  const fields = fieldsOf(input);
  const course = textOf(fields.course);
  const lesson = textOf(fields.lesson);
  const jar = await cookieJar();
  const result = await removeVideo(jar, { course, video: textOf(fields.video) });
  if (result.kind === "session") {
    const outcome = changeOutcome(result, backOf(course, lesson));
    if (outcome.kind === "leave") return leaveFor(jar, outcome);
    return { kind: "problem", problem: "unavailable" };
  }
  if (LEAVES.includes(result.kind)) return leaveFor(jar, { to: backOf(course, lesson), notice: null });
  refresh();
  if (result.kind === "deleted" || result.kind === "not_found") return { kind: "removed" };
  return { kind: "problem", problem: "unavailable" };
}
