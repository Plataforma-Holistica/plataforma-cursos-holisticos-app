"use server";

import { refresh } from "next/cache";

import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { completeRegistration, isLinkToken } from "@/services/account/account";
import { forgetRegistration } from "@/services/account/pending-registration";

import { leaveFor } from "../../_lib/exit";
import { nextAttempt } from "../../_lib/form-state";
import { forgetFormFacts } from "../../_lib/link-facts";

import { completeRegistrationOutcome, readCompleteForm, type CompleteState } from "./outcomes";

/**
 * Completar la cuenta desde el enlace del correo (FL-03; diseño PA-14, «Completa tu
 * cuenta»). Un solo envío confirma el correo, fija la contraseña, guarda nombre, edad y
 * consentimientos, y deja a la persona dentro. Todo eso lo hace el servicio, que revisa los
 * datos y los textos antes de canjear el enlace: aquí se traduce lo que contesta.
 *
 * Del estado anterior solo se lee el número de intento. La contraseña nunca vuelve en la
 * respuesta.
 */
export async function completeRegistrationAction(previous: CompleteState, form: FormData): Promise<CompleteState> {
  const input = readCompleteForm(form);
  const attempt = nextAttempt(previous);

  // Lo que no tiene forma de enlace no se le pregunta a nadie.
  if (!isLinkToken(input.token)) return { kind: "link_dead" };

  const jar = await cookieJar();
  const result = await completeRegistration(
    jar,
    { tokenHash: input.token, name: input.name, password: input.password, adultDeclared: input.adult, accepted: input.accepted },
    await requestOrigin(),
  );
  const outcome = completeRegistrationOutcome(result, input.unchecked);

  if (outcome.kind === "redirect") {
    // La cuenta ya se completó en este navegador: no queda ningún correo por revisar.
    forgetRegistration(jar);
    return leaveFor(jar, outcome);
  }

  switch (outcome.kind) {
    case "repaint":
      // La página se vuelve a pedir, y llega con los textos vigentes: lo que se recordaba de
      // ellos ya no vale. Sin esto, con JavaScript la pantalla se quedaría con los de antes.
      forgetFormFacts();
      refresh();
      return { kind: "repainted", name: input.name, attempt };
    case "invalid":
      return { kind: "invalid", name: input.name, fields: outcome.fields, attempt };
    case "unavailable":
      return { kind: "unavailable", name: input.name, attempt };
    case "texts_unavailable":
      forgetFormFacts();
      return { kind: outcome.kind };
    case "link_dead":
    case "recover_instead":
      return { kind: outcome.kind };
  }
}
