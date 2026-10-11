"use server";

import { redirect } from "next/navigation";

import { nextAttempt } from "../_lib/form-state";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { signIn } from "@/services/account/account";
import { clearNotice, leaveNotice } from "@/services/account/notice";

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
    if (outcome.notice) leaveNotice(jar, outcome.notice);
    redirect(outcome.to);
  }
  if (outcome.kind === "suspended") return { kind: "suspended" };
  return { ...outcome, email, attempt };
}
