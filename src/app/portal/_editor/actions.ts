"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import { portalCoursePath, ROUTES } from "@/services/account/navigation";
import {
  addLesson,
  addModule,
  deleteLesson,
  deleteModule,
  moveLesson,
  moveModule,
  renameModule,
  saveCourse,
  saveLesson,
} from "@/services/drafts/editor";

import { changeOutcome } from "../_lib/change";
import { checkDraftText } from "../_lib/text";
import { readEditorForm, type BlockState, type EditorRequest, type Problems } from "./outcomes";

// La acción del editor de curso (PA-43; T-402), la misma para todos sus bloques, cada uno con su estado.
// No decide quién puede: el servicio corre la guarda y la base escribe solo a nombre del maestro activo,
// buscando cada módulo y lección por su id y el del curso. Aquí se lee qué botón se pulsó, se revisan
// los textos con la regla del dominio, se llama al servicio y se traduce su respuesta.
//
// Lo agregado se abre en el editor (la dirección con `?modulo=` o `?leccion=`); lo borrado deja los datos
// del curso. Lo demás se queda y vuelve a leer el borrador: guardar una lección sube la revisión de su
// módulo, y cualquier otro formulario de la pantalla necesita la nueva. Del estado anterior solo se lee
// el número de intento.

/** Lo escrito, para que no se pierda si algo no se hizo. */
function valuesOf(request: EditorRequest): Record<string, string> {
  switch (request.step) {
    case "save_course":
      return { title: request.title, summary: request.summary, practice: request.practice ?? "", level: request.level ?? "" };
    case "add_module":
    case "add_lesson":
    case "save_module":
      return { title: request.title };
    case "save_lesson":
      return { title: request.title, description: request.description };
    default:
      return {};
  }
}

/** Lo que tiene que decirse de los textos antes de llamar a nadie. */
function problemsOf(request: EditorRequest): Problems {
  const found: Record<string, ReturnType<typeof checkDraftText>> = {};
  switch (request.step) {
    case "save_course":
      found.title = checkDraftText("courseTitle", request.title);
      found.summary = checkDraftText("summary", request.summary);
      break;
    case "add_module":
    case "save_module":
      found.title = checkDraftText("moduleTitle", request.title);
      break;
    case "add_lesson":
      found.title = checkDraftText("lessonTitle", request.title);
      break;
    case "save_lesson":
      found.title = checkDraftText("lessonTitle", request.title);
      found.description = checkDraftText("description", request.description);
      break;
    default:
      break;
  }
  return Object.fromEntries(Object.entries(found).filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null));
}

/** Qué formulario de la estructura envió, para pintar ahí su error. */
function targetOf(request: EditorRequest): string | null {
  if (request.step === "add_module") return "module";
  if (request.step === "add_lesson") return request.module;
  return null;
}

/** La pantalla a la que se vuelve: con lo elegido de ese formulario, si era un módulo o una lección. */
function backOf(request: Exclude<EditorRequest, { step: "none" | "cancel" | "ask_delete" }>): string {
  const selection = request.step === "save_module" ? { module: request.module } : request.step === "save_lesson" ? { lesson: request.lesson } : {};
  return portalCoursePath(request.course, selection) ?? ROUTES.portalCourses;
}

function ask(jar: Awaited<ReturnType<typeof cookieJar>>, request: Exclude<EditorRequest, { step: "none" | "cancel" | "ask_delete" }>) {
  const { course } = request;
  switch (request.step) {
    case "save_course":
      return saveCourse(jar, { course, seen: request.seen, title: request.title, summary: request.summary, practiceId: request.practice, levelId: request.level });
    case "add_module":
      return addModule(jar, { course, seen: request.seen, title: request.title });
    case "add_lesson":
      return addLesson(jar, { course, module: request.module, seen: request.seen, title: request.title });
    case "move_module":
      return moveModule(jar, { course, module: request.module, seenPosition: request.seen, toPosition: request.to });
    case "move_lesson":
      return moveLesson(jar, { course, lesson: request.lesson, seen: request.from, to: request.to });
    case "save_module":
      return renameModule(jar, { course, module: request.module, seen: request.seen, title: request.title });
    case "delete_module":
      return deleteModule(jar, { course, module: request.module, seen: request.seen });
    case "save_lesson":
      return saveLesson(jar, { course, lesson: request.lesson, seen: request.seen, title: request.title, description: request.description });
    case "delete_lesson":
      return deleteLesson(jar, { course, lesson: request.lesson, seen: request.seen });
  }
}

export async function editorAction(previous: BlockState, form: FormData): Promise<BlockState> {
  const request = readEditorForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  // Preguntar antes de borrar no llama a nadie: el bloque pinta la confirmación con lo que su página leyó.
  if (request.step === "ask_delete") return { kind: "confirming", attempt };

  const values = valuesOf(request);
  const target = targetOf(request);
  const problems = problemsOf(request);
  if (Object.keys(problems).length > 0) return { kind: "invalid", problems, values, target, attempt };

  const jar = await cookieJar();
  const outcome = changeOutcome(await ask(jar, request), backOf(request));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  if (outcome.kind === "done" && (outcome.answer === "created" || outcome.answer === "deleted")) {
    const selection =
      outcome.answer === "deleted" || outcome.id === null ? {} : request.step === "add_module" ? { module: outcome.id } : { lesson: outcome.id };
    return leaveFor(jar, { to: portalCoursePath(request.course, selection) ?? ROUTES.portalCourses, notice: null });
  }

  refresh();
  if (outcome.kind === "done") return { kind: "done", what: outcome.answer === "moved" ? "moved" : "saved", attempt };
  if (outcome.reason === "practice_inactive") return { kind: "invalid", problems: { practice: "practice_inactive" }, values, target, attempt };
  if (outcome.reason === "level_inactive") return { kind: "invalid", problems: { level: "level_inactive" }, values, target, attempt };
  return { kind: "failed", reason: outcome.reason, values, target, attempt };
}
