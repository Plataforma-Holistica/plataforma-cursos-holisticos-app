"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { acceptTeacherNotice } from "@/services/teachers/teachers";

import { noticeOutcome, readNoticeForm, type NoticeState } from "./outcomes";

// Aceptar el aviso de privacidad del maestro, vuelto a pedir (T-401). El servicio corre la guarda y solo anota
// para un maestro al que le falta, si ese texto sigue siendo el vigente. Del estado anterior solo se lee el intento.
export async function acceptNoticeAction(previous: NoticeState, form: FormData): Promise<NoticeState> {
  const input = readNoticeForm(form);
  const attempt = nextAttempt(previous);
  if (!input.agreed) return { kind: "missing", attempt };
  // Solo con un formulario armado a mano: se vuelve a pintar, con el texto de ahora.
  if (input.notice === null) {
    refresh();
    return { kind: "failed", reason: "changed", attempt };
  }

  const jar = await cookieJar();
  const outcome = noticeOutcome(await acceptTeacherNotice(jar, { notice: input.notice }, await requestOrigin()), input.returnTo);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return outcome.reason === null ? { kind: "idle" } : { kind: "failed", reason: outcome.reason, attempt };
}
