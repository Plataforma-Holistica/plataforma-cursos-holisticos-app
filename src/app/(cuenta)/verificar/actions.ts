"use server";

import { requestRegistration } from "@/app/_lib/mail-requests";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { ROUTES } from "@/services/account/navigation";
import { forgetRegistration, readRegistration } from "@/services/account/pending-registration";

import { leaveFor } from "../_lib/exit";
import { nextAttempt } from "../_lib/form-state";
import { rememberRequest } from "../_lib/link-facts";
import { mailRequestOutcome } from "../_lib/mail-request";

import type { ResendState } from "./outcomes";

/**
 * «Reenviar» (diseño, PA-14, «Revisa tu correo»): pide el registro otra vez, con el correo
 * que este navegador tiene anotado. El formulario no manda ningún correo: no hay campo que
 * leer. Es el mismo servicio que el del registro, con los mismos topes y la misma espera:
 * aceptado no dice que se haya mandado algo.
 *
 * Sin correo anotado no hay a quién reenviar: se vuelve al registro.
 */
export async function resendAction(previous: ResendState): Promise<ResendState> {
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();

  const pending = readRegistration(jar);
  if (pending === null) return leaveFor(jar, { to: ROUTES.signUp, notice: null });

  const outcome = mailRequestOutcome(await requestRegistration({ email: pending.email }, await requestOrigin()));
  if (outcome.kind === "failed") return { kind: "failed", reason: outcome.reason, attempt };
  if (outcome.kind === "invalid") {
    // Lo anotado no es un correo al que se pueda mandar nada: se olvida y se escribe otra vez.
    forgetRegistration(jar);
    return leaveFor(jar, { to: ROUTES.signUp, notice: null });
  }
  return { kind: "sent", wait: await rememberRequest(jar, pending.email), attempt };
}

/**
 * «Ese no es mi correo» (diseño, PA-14): olvida el correo anotado y regresa al registro. Es
 * un envío y no un enlace, porque borra una cookie. La cuenta del correo equivocado se
 * queda sin verificar y no sirve para entrar.
 */
export async function notMyEmailAction(): Promise<void> {
  const jar = await cookieJar();
  forgetRegistration(jar);
  return leaveFor(jar, { to: ROUTES.signUp, notice: null });
}
