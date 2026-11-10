"use server";

import { redirect } from "next/navigation";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { commentSessionExit } from "@/app/_comments/session-exit";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { resolveDestination } from "@/services/account/navigation";
import { proxyIsTrusted, resolveOrigin } from "@/services/account/origin";
import { startCheckout } from "@/services/billing/checkout-service";

import { plansAnswerOf, plansHref, readPlansForm, type PlansState } from "./outcomes";

// PA-04 · «Continuar al pago» (T-302). Del formulario llegan el plan, el monto y el texto que se vieron, a dónde volver y la casilla; el servicio corre la guarda,
// reserva la salida con el consentimiento y crea la sesión de pago. Lo que sale bien lleva a la página de Stripe (otro origen: con JavaScript el navegador navega
// completo, sin él contesta 303); lo demás se dice en la pantalla. Del estado anterior solo se lee el número de intento.

export async function startCheckoutAction(previous: PlansState, form: FormData): Promise<PlansState> {
  const request = readPlansForm(form);
  const attempt = nextAttempt(previous);
  if (request === null) return { kind: "idle" };
  if (request.plan === null) return { kind: "problem", problem: "choose_plan", plan: null, attempt };
  if (!request.accepted) return { kind: "problem", problem: "must_accept", plan: request.plan, attempt };
  if (request.amount === null || request.document === null) return { kind: "answer", answer: "changed", plan: request.plan, attempt };

  const returnTo = resolveDestination(request.returnTo);
  const jar = await cookieJar();
  const origin = resolveOrigin(await requestOrigin(), proxyIsTrusted());
  const answer = await startCheckout(jar, {
    plan: request.plan,
    amountSeen: request.amount,
    documentSeen: request.document,
    returnTo,
    ip: origin.address,
    userAgent: origin.userAgent,
  });
  // Fuera de cualquier `try`: `redirect` lanza.
  if (answer.kind === "redirect") redirect(answer.url);
  if (answer.kind === "session") {
    // Una cuenta suspendida se dice aquí: de vuelta a PA-04, que no la detiene, se quedaría sin decir nada.
    if (answer.check.kind === "suspended") return { kind: "answer", answer: "suspended", plan: request.plan, attempt };
    const exit = commentSessionExit(answer.check, plansHref(request.plan, request.returnTo === null ? null : returnTo));
    if (exit !== null) return leaveFor(jar, exit);
    return { kind: "answer", answer: "unavailable", plan: request.plan, attempt };
  }
  return { kind: "answer", answer: plansAnswerOf(answer), plan: request.plan, attempt };
}
