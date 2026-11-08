"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import type { CookieJar } from "@/services/account/account";
import { chooseCommentName, deleteLessonComment, editLessonComment, postLessonComment } from "@/services/comments/comments";

import {
  IDLE_COMMENTS,
  askState,
  deleteOutcome,
  nameOutcome,
  readCommentForm,
  readCommentLesson,
  writeOutcome,
  type CommentOutcome,
  type CommentRequest,
  type CommentsState,
} from "./comment-outcomes";

// Los comentarios de la lección (PA-22; T-501; RF-801, RF-808; FL-15). Una acción para todo el hilo: del formulario salen la
// lección y el botón, y del estado anterior solo el número de intento. Abrir y cerrar no llaman a nadie. Lo que escribe pasa
// por el servicio, que corre la guarda de sesión y decide el acceso con la regla única en la misma transacción que la base.
//
// Sin JavaScript, el formulario vuelve a la lección (el tercer argumento de `useActionState`), y Next la pinta otra vez con
// lo nuevo. Con JavaScript, `refresh()`, solo cuando lo que pinta la página cambió o pudo cambiar.

type Lesson = NonNullable<ReturnType<typeof readCommentLesson>>;

async function outcomeOf(jar: CookieJar, lesson: Lesson, request: Exclude<CommentRequest, { kind: "none" | "open" }>): Promise<CommentOutcome> {
  switch (request.kind) {
    case "post": {
      const parentId = request.place.kind === "reply" ? request.place.parentId : null;
      return writeOutcome(request.place, request.body ?? "", await postLessonComment(jar, { lessonId: lesson.lessonId, parentId, body: request.body }), lesson.back);
    }
    case "save":
      return writeOutcome(
        { kind: "edit", id: request.id },
        request.body ?? "",
        await editLessonComment(jar, { commentId: request.id, revision: request.revision, body: request.body }),
        lesson.back,
      );
    case "delete":
      return deleteOutcome(request.id, await deleteLessonComment(jar, { commentId: request.id, revision: request.revision }), lesson.back);
    case "name": {
      const next = nameOutcome(await chooseCommentName(jar, request.pseudonym), request.pseudonym ?? "", request.carry, lesson.back, request.keep);
      if (next.kind !== "post") return next;
      // Con el nombre ya elegido, lo que cruzaba el diálogo se publica. Pase lo que pase, la página se vuelve a pintar: el nombre ya
      // cambió, y la línea de identidad tiene que decirlo.
      const parentId = next.place.kind === "reply" ? next.place.parentId : null;
      const posted = writeOutcome(next.place, next.body, await postLessonComment(jar, { lessonId: lesson.lessonId, parentId, body: next.body }), lesson.back);
      return posted.kind === "state" ? { ...posted, refresh: true } : posted;
    }
  }
}

/** Lo que sigue a la respuesta: salir hacia otra pantalla, o pintarla en esta. */
async function settle(jar: CookieJar, outcome: CommentOutcome, attempt: number): Promise<CommentsState> {
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);
  if (outcome.refresh) refresh();
  return { ...outcome.state, attempt };
}

export async function lessonCommentAction(previous: CommentsState, form: FormData): Promise<CommentsState> {
  const attempt = nextAttempt(previous);
  const lesson = readCommentLesson(form);
  const request = readCommentForm(form);
  if (lesson === null || request.kind === "none") return { ...IDLE_COMMENTS, attempt };
  if (request.kind === "open") return { ...askState(request), attempt };
  const jar = await cookieJar();
  return settle(jar, await outcomeOf(jar, lesson, request), attempt);
}
