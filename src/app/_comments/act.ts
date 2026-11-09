import "server-only";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import {
  deleteOutcome,
  nameOutcome,
  writeOutcome,
  type CommentOutcome,
  type CommentRequest,
  type CommentsState,
} from "./outcomes";
import type { CookieJar } from "@/services/account/account";
import { chooseCommentName, deleteLessonComment, editLessonComment, postLessonComment } from "@/services/comments/comments";

// Lo que hacen las acciones de comentarios con cada pedido que escribe (T-501): la de la lección (PA-22) y la del portal (PA-45).
// Las dos pasan por las mismas entradas del servicio, que corren la guarda de sesión y deciden el acceso con la regla única;
// cambia a dónde se vuelve (`back`).

export interface ActLesson {
  lessonId: string;
  /** A dónde vuelve una sesión que no pasa. */
  back: string;
}

export async function outcomeOf(jar: CookieJar, lesson: ActLesson, request: Exclude<CommentRequest, { kind: "none" | "open" }>): Promise<CommentOutcome> {
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
export async function settle(jar: CookieJar, outcome: CommentOutcome, attempt: number): Promise<CommentsState> {
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);
  if (outcome.refresh) refresh();
  return { ...outcome.state, attempt };
}

