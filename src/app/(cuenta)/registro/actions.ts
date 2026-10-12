"use server";

import { requestRegistration } from "@/app/_lib/mail-requests";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { ROUTES } from "@/services/account/navigation";

import { leaveFor } from "../_lib/exit";
import { nextAttempt } from "../_lib/form-state";
import { rememberRequest } from "../_lib/link-facts";
import { checkEmailField, mailRequestOutcome, readEmailForm, type MailRequestState } from "../_lib/mail-request";

/**
 * Pedir el registro (FL-02; diseño PA-10). El servicio cuenta el intento, aplica los topes
 * y manda la invitación detrás de la respuesta; aquí se traduce lo que contesta.
 *
 * Aceptado no dice que se haya mandado algo: es la misma respuesta para un correo nuevo,
 * para uno que ya tiene cuenta y para uno que ya recibió demasiados correos. Siempre lleva
 * a «Revisa tu correo», y no abre sesión.
 *
 * Del estado anterior solo se lee el número de intento.
 */
export async function requestRegistrationAction(previous: MailRequestState, form: FormData): Promise<MailRequestState> {
  const { email } = readEmailForm(form);
  const attempt = nextAttempt(previous);

  const field = checkEmailField(email);
  if (field) return { kind: "invalid", email, field, attempt };

  const outcome = mailRequestOutcome(await requestRegistration({ email }, await requestOrigin()));
  if (outcome.kind !== "accepted") return { ...outcome, email, attempt };

  const jar = await cookieJar();
  // El correo viaja a la pantalla siguiente en una cookie corta, no en la dirección.
  await rememberRequest(jar, email);
  return leaveFor(jar, { to: ROUTES.verify, notice: null });
}
