"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { acceptTeacherInvitation } from "@/services/teachers/teachers";

import { acceptOutcome, readInvitationForm, type InvitationState } from "./outcomes";

// Aceptar la invitación (PA-40, T-401). No decide quién puede: el servicio corre la guarda de sesión y la base
// busca la invitación por el correo de la cuenta, con el resguardo de ese navegador. Una casilla sin marcar se
// dice sin llamar a nadie. Del estado anterior solo se lee el número de intento.
export async function acceptInvitationAction(previous: InvitationState, form: FormData): Promise<InvitationState> {
  const input = readInvitationForm(form);
  const attempt = nextAttempt(previous);
  if (!input.agreed || !input.noticeAgreed) return { kind: "missing", agreed: input.agreed, noticeAgreed: input.noticeAgreed, attempt };
  // Solo con un formulario armado a mano: se vuelve a pintar, con los textos de ahora.
  if (input.shown === null) {
    refresh();
    return { kind: "failed", reason: "changed", attempt };
  }

  const jar = await cookieJar();
  const outcome = acceptOutcome(await acceptTeacherInvitation(jar, input.shown, await requestOrigin()));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  if (outcome.kind === "suspended" || outcome.reason === null) return { kind: "idle" };
  return { kind: "failed", reason: outcome.reason, attempt };
}
