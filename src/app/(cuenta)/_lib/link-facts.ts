import "server-only";

import { accountFormFacts, type CookieJar } from "@/services/account/account";
import { rememberRegistration } from "@/services/account/pending-registration";

import { resendWait, type ResendWait } from "../verificar/outcomes";

// Lo que una acción que acaba de pedir un correo necesita saber para contarlo: cuánto dura
// el enlace y cuánto hay que esperar para pedir otro. Son parámetros, y viven en la base.
//
// Se leen después de pedir el correo, nunca antes: lo que se le contesta a quien pide no
// puede depender de si ese correo tiene cuenta, y esta lectura tarda lo mismo en los dos
// casos. Si no se supo, la pantalla dice lo mismo sin la cifra.

/** Lo que dura un enlace del correo (`VIGENCIA_ENLACE_CONTRASENA`), en segundos, o nulo si no se supo. */
export async function linkLifetimeSeconds(): Promise<number | null> {
  const facts = await accountFormFacts();
  return facts.kind === "ready" ? facts.linkLifetimeMinutes * 60 : null;
}

/**
 * Lo que «Revisa tu correo» dice de un registro anotado: cuánto dura el enlace y cuánto le
 * falta a «Reenviar». Nulo si no se supo: la pantalla lo calla y deja reenviar, porque la
 * espera de verdad la lleva el servicio.
 *
 * @param sentAt Cuándo se pidió el último envío, en milisegundos.
 */
export async function pendingRequestFacts(sentAt: number): Promise<{ lifetimeSeconds: number; wait: ResendWait | null } | null> {
  const facts = await accountFormFacts();
  if (facts.kind !== "ready") return null;
  return { lifetimeSeconds: facts.linkLifetimeMinutes * 60, wait: resendWait(sentAt, facts.resendWaitSeconds, Date.now()) };
}

/**
 * Anota en este navegador a qué correo se le acaba de pedir el enlace de registro, para que
 * «Revisa tu correo» lo diga y deje reenviarlo (diseño, PA-14). La cookie dura lo que el
 * enlace. Si no se supo cuánto dura, no se anota nada: la pantalla pinta su texto genérico.
 *
 * @returns La espera que le queda a «Reenviar», o nulo.
 */
export async function rememberRequest(jar: CookieJar, email: string): Promise<ResendWait | null> {
  const facts = await accountFormFacts();
  if (facts.kind !== "ready") return null;
  const sentAt = Date.now();
  rememberRegistration(jar, { email, sentAt }, facts.linkLifetimeMinutes * 60);
  return resendWait(sentAt, facts.resendWaitSeconds, sentAt);
}
