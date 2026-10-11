"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { nextAttempt } from "../_lib/form-state";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { signIn } from "@/services/account/account";
import { clearNotice, leaveNotice } from "@/services/account/notice";

import { checkSignInForm, signInOutcome, type SignInState } from "./outcomes";

// Lo que llega del formulario. Lo que no sea un texto, o venga desmedido, cuenta como
// vacío: una acción de servidor es una puerta pública, y el formulario lo arma quien pide.
const input = z.object({
  email: z.string().max(320).catch(""),
  password: z.string().max(1024).catch(""),
  volver: z.string().max(2048).catch(""),
});

/**
 * Entrar (FL-05; diseño PA-11). El servicio cuenta el intento, le pregunta a Auth, corre la
 * guarda y escribe la cookie solo si la persona entra; aquí se traduce su respuesta.
 *
 * Del estado anterior solo se lee el número de intento: lo demás lo manda el navegador.
 * La contraseña nunca vuelve en la respuesta.
 */
export async function signInAction(previous: SignInState, form: FormData): Promise<SignInState> {
  const { email, password, volver } = input.parse({
    email: form.get("email"),
    password: form.get("password"),
    volver: form.get("volver"),
  });
  const attempt = nextAttempt(previous);

  const fields = checkSignInForm({ email, password });
  if (fields) return { kind: "invalid", email, fields, attempt };

  const jar = await cookieJar();
  // El aviso con el que se llegó ya se leyó: no vuelve a salir con la respuesta.
  clearNotice(jar);
  const outcome = signInOutcome(await signIn(jar, { email, password }, await requestOrigin()), volver);

  if (outcome.kind === "redirect") {
    if (outcome.notice) leaveNotice(jar, outcome.notice);
    redirect(outcome.to);
  }
  if (outcome.kind === "suspended") return { kind: "suspended" };
  return { ...outcome, email, attempt };
}
