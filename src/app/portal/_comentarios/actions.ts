"use server";

import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { outcomeOf, settle } from "@/app/_comments/act";
import { IDLE_COMMENTS, askState, readCommentForm, readCommentLesson, type CommentsState } from "@/app/_comments/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { ROUTES } from "@/services/account/navigation";

// PA-45 (T-501; RF-609): responder, editar y borrar lo propio desde el portal, por las mismas entradas que la lección. La lección
// viaja en cada formulario (la de ese comentario), y el servicio decide el acceso con la regla única, como en PA-22. Una sesión que
// no pasa vuelve a PA-45. Sin JavaScript, el formulario vuelve a la página del portal en que se estaba.

export async function teacherCommentAction(previous: CommentsState, form: FormData): Promise<CommentsState> {
  const attempt = nextAttempt(previous);
  const lesson = readCommentLesson(form);
  const request = readCommentForm(form);
  if (lesson === null || request.kind === "none") return { ...IDLE_COMMENTS, attempt };
  if (request.kind === "open") return { ...askState(request), attempt };
  const jar = await cookieJar();
  return settle(jar, await outcomeOf(jar, { ...lesson, back: ROUTES.portalComments }, request), attempt);
}
