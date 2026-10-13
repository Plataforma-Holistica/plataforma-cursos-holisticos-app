"use server";

import { cookieJar } from "@/app/_lib/request-context";
import { giveSecondFactorCode } from "@/services/account/account";

import { leaveFor } from "../../_lib/exit";
import { nextAttempt } from "../../_lib/form-state";

import { checkCode, giveCodeOutcome, readGiveCodeForm, type GiveCodeState } from "./outcomes";

/**
 * Dar el código del segundo factor al entrar (diseño, PA-12; RF-106). El servicio vuelve a
 * correr la guarda de sesión, le pregunta a la base si quien pide está a un código de entrar
 * y verifica contra el factor que la base dice: del formulario solo llegan el código y el
 * destino guardado. Aquí se traduce su respuesta.
 *
 * Un código sin forma no llega al servicio: no es un intento, y no cuenta en el freno.
 * Del estado anterior solo se lee el número de intento. El código nunca vuelve en la respuesta.
 */
export async function giveCodeAction(previous: GiveCodeState, form: FormData): Promise<GiveCodeState> {
  const { code, returnTo } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = giveCodeOutcome(await giveSecondFactorCode(jar, code), returnTo);

  // Si la sesión ya no vale, se cierra antes de irse.
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);
  if (outcome.kind === "suspended") return { kind: "suspended" };
  return { kind: "failed", reason: outcome.reason, attempt };
}
