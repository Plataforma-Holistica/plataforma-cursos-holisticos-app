"use server";

import { cookieJar } from "@/app/_lib/request-context";
import { confirmSecondFactor, startSecondFactor } from "@/services/account/account";

import { leaveFor } from "../../../_lib/exit";
import { nextAttempt } from "../../../_lib/form-state";

import { checkConfirmForm, confirmOutcome, readConfirmForm, startOutcome, type ConfirmState, type StartState } from "./outcomes";

/** La imagen del código QR como dirección de datos, para un `<img>`: nunca se incrusta como HTML. */
const qrAddress = (svg: string | null): string | null =>
  svg === null ? null : `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

/**
 * «Empezar» a configurar el segundo factor (diseño, PA-12; RF-106). El servicio corre la
 * guarda de sesión, comprueba que quien pide tenga una invitación que puede aceptar y el
 * buzón probado, da de alta el factor en Auth y lo anota en ese navegador. Del formulario no
 * se lee nada.
 *
 * La clave y su código QR vuelven en la respuesta, para pintarse una vez. No se guardan, no
 * viajan en un campo oculto y no se escriben en ningún registro. Del estado anterior solo se
 * lee el número de intento.
 */
export async function startSecondFactorAction(previous: StartState): Promise<StartState> {
  const attempt = nextAttempt(previous);

  const jar = await cookieJar();
  const outcome = startOutcome(await startSecondFactor(jar));

  // Si la sesión ya no vale, se cierra antes de irse.
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);

  switch (outcome.kind) {
    case "started":
      return { kind: "started", factorId: outcome.factorId, secret: outcome.secret, uri: outcome.uri, qr: qrAddress(outcome.qr), attempt };
    case "unavailable":
      return { kind: "unavailable", attempt };
    default:
      return { kind: outcome.kind };
  }
}

/**
 * Confirmar el segundo factor con el código de la aplicación, que es aceptar la invitación
 * (diseño, PA-12; RF-106, RF-712). El servicio corre la guarda, verifica el factor que el
 * servidor anotó en ese navegador y le pide a la base que acepte. Del formulario llegan el
 * código, el código dictado y el factor que la pantalla pintó, que solo se compara: qué
 * factor se ata no lo decide nada de lo que llega.
 *
 * Un código sin forma no llega al servicio: no es un intento, y no cuenta en el freno.
 * Del estado anterior solo se lee el número de intento.
 */
export async function confirmSecondFactorAction(previous: ConfirmState, form: FormData): Promise<ConfirmState> {
  const { code, handoff, painted } = readConfirmForm(form);
  const attempt = nextAttempt(previous);

  const fields = checkConfirmForm({ code });
  if (fields) return { kind: "invalid", fields, attempt };

  const jar = await cookieJar();
  const outcome = confirmOutcome(await confirmSecondFactor(jar, { code, handoff, painted }), handoff);

  // Aceptada, sale a entrar con su aviso. Si la sesión ya no vale, se cierra antes de irse.
  if (outcome.kind === "redirect") return leaveFor(jar, outcome);

  switch (outcome.kind) {
    case "invalid":
      return { kind: "invalid", fields: outcome.fields, attempt };
    case "start_again":
      return { kind: "start_again", attempt };
    case "unavailable":
      return { kind: "unavailable", attempt };
    default:
      return { kind: outcome.kind };
  }
}
