"use server";

import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { outcomeOf, settle } from "@/app/_comments/act";
import { cookieJar } from "@/app/_lib/request-context";

import { IDLE_COMMENTS, askState, readCommentForm, readCommentLesson, type CommentsState } from "./comment-outcomes";

// Los comentarios de la lección (PA-22; T-501; RF-801, RF-808; FL-15). Una acción para todo el hilo: del formulario salen la
// lección y el botón, y del estado anterior solo el número de intento. Abrir y cerrar no llaman a nadie. Lo que escribe pasa
// por el servicio, que corre la guarda de sesión y decide el acceso con la regla única en la misma transacción que la base.
//
// Sin JavaScript, el formulario vuelve a la lección (el tercer argumento de `useActionState`), y Next la pinta otra vez con
// lo nuevo. Con JavaScript, `refresh()`, solo cuando lo que pinta la página cambió o pudo cambiar.

export async function lessonCommentAction(previous: CommentsState, form: FormData): Promise<CommentsState> {
  const attempt = nextAttempt(previous);
  const lesson = readCommentLesson(form);
  const request = readCommentForm(form);
  if (lesson === null || request.kind === "none") return { ...IDLE_COMMENTS, attempt };
  if (request.kind === "open") return { ...askState(request), attempt };
  const jar = await cookieJar();
  return settle(jar, await outcomeOf(jar, lesson, request), attempt);
}
