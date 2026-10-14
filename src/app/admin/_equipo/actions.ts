"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import {
  giveFreshCode,
  grantCapability,
  inviteAdmin,
  reinviteAdmin,
  resetSecondFactor,
  revokeCapability,
  revokeInvitation,
} from "@/services/account/account";

import {
  checkInviteForm,
  freshCodeOutcome,
  grantOutcome,
  inviteOutcome,
  readInvitationsForm,
  readInviteForm,
  readResetForm,
  readTeamForm,
  reinviteOutcome,
  resetOutcome,
  revokeInvitationOutcome,
  revokeOutcome,
  shownEmail,
  type CodeState,
  type InvitationsState,
  type InviteState,
  type ResetState,
  type TeamState,
} from "./outcomes";

// Las acciones de la pantalla del equipo (diseño, PA-86; RF-712). Cada bloque tiene la suya.
// Ninguna decide quién puede: el servicio corre la guarda y la base vuelve a comprobar que
// quien pide tenga configuración y un código reciente. Aquí se lee qué botón se pulsó, se
// llama al servicio y se traduce su respuesta con la tabla de la pantalla.
//
// Del estado anterior solo se lee el número de intento. A quién se le hace algo sale del
// valor del botón pulsado, y quién lo hace, de la sesión.

/**
 * Dar el código otra vez, para que un cambio al equipo pase su puerta. Un código sin forma
 * no llega al servicio: no es un intento, y no cuenta en el freno. Verificado, se redirige
 * a esta misma página en vez de pintarla: recargar no reenvía el código. El código nunca
 * vuelve en la respuesta.
 */
export async function freshCodeAction(previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = freshCodeOutcome(await giveFreshCode(jar, code));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * Invitar a un correo a recibir capacidades. No manda ningún correo: la pantalla le dice a
 * quien invita qué avisarle a la persona. Lo escrito vuelve con cada respuesta que no sea
 * «hecho», para que no se pierda.
 */
export async function inviteAction(previous: InviteState, form: FormData): Promise<InviteState> {
  const input = readInviteForm(form);
  const attempt = nextAttempt(previous);

  // Lo que se detiene aquí no le pregunta nada a nadie.
  const problems = checkInviteForm(input);
  if (problems) return { kind: "invalid", ...input, problems, attempt };

  const jar = await cookieJar();
  const outcome = inviteOutcome(await inviteAdmin(jar, input));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);

  // La página se vuelve a pedir: la lista ya trae la invitación, o dice que falta el código.
  refresh();
  switch (outcome.kind) {
    case "done":
      return { kind: "done", answer: outcome.answer, email: shownEmail(input.email), attempt };
    case "invalid":
      return { kind: "invalid", ...input, problems: outcome.problems, attempt };
    case "failed":
      return { kind: "failed", reason: outcome.reason, ...input, attempt };
  }
}

/**
 * Dar o quitar una capacidad. El primer envío de lo que se pregunta antes (quitar, y dar
 * configuración) no llama a nadie: contesta «confirma», y la pantalla pinta qué va a pasar.
 * El segundo lleva lo que se confirmó, y el servicio comprueba que siga siendo cierto.
 */
export async function teamAction(previous: TeamState, form: FormData): Promise<TeamState> {
  const request = readTeamForm(form);
  // «Cancelar», o un envío que no se entiende: no se le pregunta nada a nadie.
  if (request.step === "none") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const { intent } = request;
  if (request.step === "ask") return { kind: "confirm", intent, changed: false, attempt };

  const jar = await cookieJar();
  const outcome =
    intent.type === "grant"
      ? grantOutcome(await grantCapability(jar, { profile: intent.profile, capability: intent.capability }))
      : revokeOutcome(await revokeCapability(jar, { profile: intent.profile, capability: intent.capability, confirmed: request.confirmed }));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);

  // La página se vuelve a pedir: la lista pudo cambiar, se haya hecho o no.
  refresh();
  switch (outcome.kind) {
    case "done":
      return { kind: "done", what: outcome.what, attempt };
    case "confirm_again":
      return { kind: "confirm", intent, changed: true, attempt };
    case "failed":
      return { kind: "failed", reason: outcome.reason, attempt };
    case "idle":
      return { kind: "idle" };
  }
}

/**
 * Revocar una invitación, o invitar de nuevo a quien tenía una que caducó. Revocar se
 * pregunta antes, y ese primer envío no llama a nadie. Al invitar de nuevo, a quién y con
 * qué lo lee el servicio de lo que la base tiene de esa invitación: del formulario solo
 * llega cuál es.
 */
export async function invitationsAction(previous: InvitationsState, form: FormData): Promise<InvitationsState> {
  const request = readInvitationsForm(form);
  if (request.step === "none") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  if (request.step === "ask") return { kind: "confirm", id: request.id, attempt };

  const jar = await cookieJar();
  const outcome =
    request.step === "revoke"
      ? revokeInvitationOutcome(await revokeInvitation(jar, { id: request.id }))
      : reinviteOutcome(await reinviteAdmin(jar, { id: request.id }));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);

  refresh();
  switch (outcome.kind) {
    case "done":
      return { kind: "done", what: outcome.what, attempt };
    case "failed":
      return { kind: "failed", reason: outcome.reason, attempt };
    case "idle":
      return { kind: "idle" };
  }
}

/**
 * Restablecerle el segundo factor a alguien, en dos envíos. El primero (a quién) no llama a
 * nadie: contesta «confirma», y la pantalla pinta qué va a pasar con lo que su página leyó,
 * como en los demás bloques. El segundo restablece, con la versión de la persona que la
 * página puso en el botón: un formulario reenviado trae la de antes, y no restablece otra
 * vez. Su respuesta trae el código que hay que dictar: sale una sola vez, y mientras sea el
 * estado de esta acción la pantalla no pinta ningún formulario suyo.
 */
export async function resetAction(previous: ResetState, form: FormData): Promise<ResetState> {
  const request = readResetForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const { profile } = request;
  if (request.step === "choose") return { kind: "confirm", profile, changed: false, attempt };

  const jar = await cookieJar();
  const outcome = resetOutcome(await resetSecondFactor(jar, { profile, confirmed: request.confirmed, version: request.version }));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);

  // Con el código en la mano la página no se vuelve a pedir: si esa lectura fallara, o la
  // guarda redirigiera, la pantalla se iría y el código, que ya es el único que vale, no
  // llegaría a pintarse. Restablecer no escribe ninguna cookie, así que con JavaScript la
  // página no se repinta, salvo que el paso previo haya renovado la sesión en ese mismo
  // envío; sin JavaScript se pinta siempre. Son límites conocidos. La lista se pone al día
  // con el enlace del bloque, que carga todo.
  if (outcome.kind === "code") return { kind: "code", code: outcome.code, attempt };

  // La página se vuelve a pedir: lo que la confirmación dice sale de la lista de ahora.
  refresh();
  switch (outcome.kind) {
    case "confirm_again":
      return { kind: "confirm", profile, changed: true, attempt };
    case "idle":
      return { kind: "idle" };
    case "failed":
      return { kind: "failed", reason: outcome.reason, attempt };
  }
}
