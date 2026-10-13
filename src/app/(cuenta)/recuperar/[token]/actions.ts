"use server";

import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { completeRecovery, isLinkToken } from "@/services/account/account";

import { leaveFor } from "../../_lib/exit";
import { nextAttempt } from "../../_lib/form-state";

import { completeRecoveryOutcome, readChangePasswordForm, type ChangePasswordState } from "./outcomes";

/**
 * Cambiar la contraseña desde el enlace del correo (FL-06; diseño PA-13, «cambiar»). El
 * servicio revisa la contraseña antes de canjear el enlace, la guarda, cierra todas las
 * sesiones de la cuenta y no abre ninguna: aquí se traduce lo que contesta.
 *
 * Del estado anterior solo se lee el número de intento. La contraseña nunca vuelve en la
 * respuesta.
 */
export async function completeRecoveryAction(previous: ChangePasswordState, form: FormData): Promise<ChangePasswordState> {
  const input = readChangePasswordForm(form);
  const attempt = nextAttempt(previous);

  // Lo que no tiene forma de enlace no se le pregunta a nadie.
  if (!isLinkToken(input.token)) return { kind: "link_dead" };

  // El tarro va al servicio: abrir el enlace prueba el buzón, y el resguardo de esa prueba
  // se queda en este navegador (TRD §9.2, fila «Invitaciones»).
  const jar = await cookieJar();
  const result = await completeRecovery({ tokenHash: input.token, password: input.password }, await requestOrigin(), jar);
  const outcome = completeRecoveryOutcome(result);

  // A entrar, sin sesión en este navegador y con el aviso de que la contraseña cambió.
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);

  switch (outcome.kind) {
    case "invalid":
      return { kind: "invalid", problem: outcome.problem, attempt };
    case "unavailable":
      return { kind: "unavailable", attempt };
    case "link_dead":
    case "request_new_link":
      return { kind: outcome.kind };
  }
}
