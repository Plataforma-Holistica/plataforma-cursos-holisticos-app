"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import { deleteLessonComment } from "@/services/comments/comments";

import { IDLE_MINE, myDeleteOutcome, readMyCommentsForm, type MineState } from "./outcomes";

// «Mis comentarios» (PA-24; T-501): preguntar y cancelar no llaman a nadie; borrar pasa por el servicio, que corre la guarda de
// sesión, con el comentario y la revisión que se vieron. La base solo borra lo propio. Sin JavaScript, el formulario vuelve a la
// página de la lista en que se estaba; con él, `refresh()` cuando la lista cambió o pudo cambiar.

export async function myCommentsAction(previous: MineState, form: FormData): Promise<MineState> {
  const attempt = nextAttempt(previous);
  const request = readMyCommentsForm(form);
  if (request.kind === "none") return { ...IDLE_MINE, attempt };
  if (request.kind !== "delete") return { attempt, asking: request.kind === "ask" ? request.id : null, notice: null };
  const jar = await cookieJar();
  const outcome = myDeleteOutcome(request.id, await deleteLessonComment(jar, { commentId: request.id, revision: request.revision }), request.back);
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);
  if (outcome.refresh) refresh();
  return { ...outcome.state, attempt };
}
