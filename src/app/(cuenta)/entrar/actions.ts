"use server";

import { leaveFor } from "../_lib/exit";
import { nextAttempt } from "../_lib/form-state";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { signIn } from "@/services/account/account";
import { clearNotice } from "@/services/account/notice";
import { forgetRegistration } from "@/services/account/pending-registration";

import { checkSignInForm, readSignInForm, signInOutcome, type SignInState } from "./outcomes";

/**
 * Entrar (FL-05; diseño PA-11). El servicio cuenta el intento, le pregunta a Auth, corre la
 * guarda y escribe la cookie solo si la persona entra; aquí se traduce su respuesta.
 *
 * Del estado anterior solo se lee el número de intento: lo demás lo manda el navegador.
 * La contraseña nunca vuelve en la respuesta.
 */
export async function signInAction(previous: SignInState, form: FormData): Promise<SignInState> {
  const { email, password, returnTo } = readSignInForm(form);
  const attempt = nextAttempt(previous);

  const fields = checkSignInForm({ email, password });
  if (fields) return { kind: "invalid", email, fields, attempt };

  const jar = await cookieJar();
  // El aviso con el que se llegó ya se leyó: no vuelve a salir con la respuesta.
  clearNotice(jar);
  const outcome = signInOutcome(await signIn(jar, { email, password }, await requestOrigin()), returnTo);

  if (outcome.kind === "redirect") {
    // Quien entra ya no tiene un correo por revisar en este navegador: sin esto, «Revisa tu
    // correo» seguiría enseñando el de un registro anterior a quien lo use después.
    forgetRegistration(jar);
    return leaveFor(jar, outcome);
  }
  if (outcome.kind === "suspended") return { kind: "suspended" };
  return { ...outcome, email, attempt };
}
