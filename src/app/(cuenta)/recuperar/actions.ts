"use server";

import { requestRecovery } from "@/app/_lib/mail-requests";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { clearNotice } from "@/services/account/notice";

import { nextAttempt } from "../_lib/form-state";
import { linkLifetimeSeconds } from "../_lib/link-facts";
import { checkEmailField, mailRequestOutcome, readEmailForm, type MailRequestState } from "../_lib/mail-request";

/**
 * Pedir el enlace para cambiar la contraseña (FL-06; diseño PA-13, «pedir»). El servicio
 * cuenta el intento, aplica los topes y le pide el correo a Auth detrás de la respuesta;
 * aquí se traduce lo que contesta.
 *
 * Aceptado no dice que ese correo tenga cuenta ni que se haya mandado algo: el mensaje es
 * el mismo en todos los casos, y la pantalla no cambia de lugar.
 *
 * Del estado anterior solo se lee el número de intento.
 */
export async function requestRecoveryAction(previous: MailRequestState, form: FormData): Promise<MailRequestState> {
  const { email } = readEmailForm(form);
  const attempt = nextAttempt(previous);

  // El aviso con el que se llegó ya se leyó: no vuelve a salir con la respuesta.
  clearNotice(await cookieJar());

  const field = checkEmailField(email);
  if (field) return { kind: "invalid", email, field, attempt };

  const outcome = mailRequestOutcome(await requestRecovery({ email }, await requestOrigin()));
  if (outcome.kind !== "accepted") return { ...outcome, email, attempt };

  // El correo no vuelve: la respuesta no repite a quién se le habría mandado.
  return { kind: "sent", lifetimeSeconds: await linkLifetimeSeconds(), attempt };
}
