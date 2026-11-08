"use server";

import { refresh } from "next/cache";
import { after } from "next/server";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { sendQueuedMail } from "@/app/_lib/mail-requests";
import { cookieJar } from "@/app/_lib/request-context";
import { clearNotice } from "@/services/account/notice";
import { giveBillingCode, resolveBillingEvent, retryBillingEvent } from "@/services/billing/billing";

import { askedBy, billingCodeOutcome, readBillingForm, resolveOutcome, retryOutcome, type BillingOutcome, type BillingState, type CodeState } from "./outcomes";

// Las acciones de PA-84 (la cola de los avisos de cobro; FL-55; T-303, tercera solicitud). Ninguna decide quién puede: el servicio corre la guarda, y la base vuelve a
// comprobar que quien actúa tenga finanzas, un código reciente y que el aviso no sea de su propio pago. Aquí se lee qué se pidió, se llama al servicio y se traduce
// su respuesta con la tabla de la pantalla.

/** Dar el código otra vez, para que las acciones pasen su puerta. Verificado, se redirige a esta misma página: recargar no reenvía el código. */
export async function billingCodeAction(previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = billingCodeOutcome(await giveBillingCode(jar, code));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * «Reintentar» o «Resolver a mano». Resolver va en dos pasos: el primero solo pregunta en su fila, sin llamar a nadie, y confirmar sin nota vuelve a preguntar.
 * Reintentar procesa en el momento; lo que pase del tope sigue detrás de la respuesta, y lo que eso encole (un recibo, un CO-22) sale después. Lo que sale bien
 * redirige a esta misma página con su aviso; lo demás vuelve a pedir la página: la cola pudo cambiar.
 */
export async function billingEventsAction(previous: BillingState, form: FormData): Promise<BillingState> {
  const request = readBillingForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  // El aviso con el que se llegó ya se leyó: no vuelve a salir junto a otra respuesta.
  clearNotice(jar);
  const asked = askedBy(request);
  if (asked !== null) return { kind: "confirming", asked, note: request.note, attempt };

  let outcome: BillingOutcome;
  if (request.step === "retry") {
    const result = await retryBillingEvent(jar, { event: request.event, revision: request.revision });
    // Procesar pudo encolar un recibo o un CO-22: sale detrás de la respuesta, y si pasó del tope, cuando termine.
    if (result.kind === "ran") {
      const rest = result.rest;
      if (rest === undefined) await sendQueuedMail();
      else after(() => rest.then(() => sendQueuedMail()));
    }
    outcome = retryOutcome(result);
  } else {
    outcome = resolveOutcome(await resolveBillingEvent(jar, { event: request.event, revision: request.revision, note: request.note }));
  }
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return {
    kind: "failed",
    reason: outcome.reason,
    code: outcome.code ?? null,
    event: request.event,
    note: request.step === "resolve" ? request.note : undefined,
    attempt,
  };
}
