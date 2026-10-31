"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { adminTeacherPath, ROUTES } from "@/services/account/navigation";
import { clearNotice } from "@/services/account/notice";
import {
  decideTeacherFraud,
  giveTeacherCode,
  inviteTeacher,
  liftTeacherSuspension,
  reinviteTeacher,
  revokeTeacherInvitation,
  setTeacherFounder,
  suspendTeacher,
} from "@/services/teachers/teacher-admin";

import {
  decideOutcome,
  founderOutcome,
  inviteOutcome,
  liftOutcome,
  problemsOf,
  readTeachersForm,
  reinviteOutcome,
  revokeOutcome,
  suspendOutcome,
  teachersCodeOutcome,
  type CodeState,
  type TeachersOutcome,
  type TeachersState,
} from "./outcomes";

// Las acciones de administrar a los maestros (PA-65 y PA-66; FL-46; T-401). Ninguna decide quién puede: el servicio corre
// la guarda, y la base vuelve a comprobar que quien pide tenga Contenido y un código reciente. Aquí se lee qué se pidió, se
// llama al servicio y se traduce su respuesta con la tabla de la pantalla.

/**
 * Dar el código otra vez, desde la lista o desde una ficha (`teacher`): se vuelve a la propia página. Un código sin forma no
 * llega al servicio. Verificado, se redirige: recargar no lo reenvía.
 */
export async function teachersCodeAction(teacher: unknown, previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);
  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = teachersCodeOutcome(await giveTeacherCode(jar, code), teacher);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * Un cambio a los maestros. Lo que falta se dice sin llamar a nadie. Suspender y confirmar un fraude van en dos pasos: el
 * primero solo pregunta. Lo que sale bien redirige con su aviso; lo demás vuelve a pedir la página: la lista pudo cambiar.
 */
export async function teachersAction(previous: TeachersState, form: FormData): Promise<TeachersState> {
  const request = readTeachersForm(form);
  if (request.step === "none") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  if (request.step === "cancel") return { kind: "editing", form: request.form, teacher: request.teacher, drafts: request.drafts, attempt };
  const teacher = request.step === "invite" ? null : request.teacher;
  const problems = problemsOf(request);
  if (problems.length > 0) return { kind: "invalid", step: request.step, teacher, problems, drafts: request.drafts, attempt };
  if (request.step === "ask_suspend") return { kind: "asking", ask: "suspend", teacher: request.teacher, drafts: request.drafts, attempt };
  if (request.step === "ask_confirm") return { kind: "asking", ask: "confirm", teacher: request.teacher, drafts: request.drafts, attempt };

  const jar = await cookieJar();
  // El aviso con el que se llegó ya se leyó: no vuelve a salir junto a otra respuesta.
  clearNotice(jar);
  const page = teacher === null ? ROUTES.adminTeachers : adminTeacherPath(teacher);
  let outcome: TeachersOutcome;
  switch (request.step) {
    case "invite":
      outcome = inviteOutcome(await inviteTeacher(jar, { name: request.drafts.name, email: request.drafts.email }));
      break;
    case "reinvite":
      outcome = reinviteOutcome(await reinviteTeacher(jar, { teacher: request.teacher, seen: request.seen }));
      break;
    case "revoke":
      outcome = revokeOutcome(await revokeTeacherInvitation(jar, { teacher: request.teacher, seen: request.seen }));
      break;
    case "founder":
      outcome = founderOutcome(await setTeacherFounder(jar, { teacher: request.teacher, seen: request.seen, since: request.drafts.since }), page);
      break;
    case "clear_founder":
      outcome = founderOutcome(await setTeacherFounder(jar, { teacher: request.teacher, seen: request.seen, since: null }), page);
      break;
    case "suspend":
      outcome = suspendOutcome(
        await suspendTeacher(jar, { teacher: request.teacher, seen: request.seen, reason: request.drafts.reason, notice: request.drafts.notice }),
        page,
      );
      break;
    case "lift":
      outcome = liftOutcome(await liftTeacherSuspension(jar, { teacher: request.teacher, seen: request.seen }), page);
      break;
    case "confirm":
    case "reject":
      outcome = decideOutcome(
        await decideTeacherFraud(jar, {
          teacher: request.teacher,
          seen: request.seen,
          request: request.request,
          confirm: request.step === "confirm",
          note: request.drafts.note ?? null,
          notice: request.drafts.notice ?? null,
        }),
        page,
      );
      break;
  }
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "failed", reason: outcome.reason, step: request.step, teacher, drafts: request.drafts, attempt };
}
