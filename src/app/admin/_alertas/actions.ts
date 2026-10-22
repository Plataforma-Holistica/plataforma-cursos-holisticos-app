"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { clearNotice } from "@/services/account/notice";
import { decideFraud, excludeAccount, giveFinanceCode, reviewAlert, revokeExclusion } from "@/services/anomalies/anomalies";

import {
  alertsCodeOutcome,
  askedBy,
  excludeOutcome,
  fraudOutcome,
  readAlertsForm,
  reviewOutcome,
  revokeOutcome,
  type AlertsOutcome,
  type AlertsState,
  type CodeState,
} from "./outcomes";

// Las acciones de PA-68 mínima (las alertas de anomalía; FL-64; T-208). Ninguna decide quién
// puede: el servicio corre la guarda, y la base vuelve a comprobar que quien decide tenga Finanzas
// y un código reciente. Aquí se lee qué se pidió, se llama al servicio y se traduce su respuesta
// con la tabla de la pantalla.

/**
 * Dar el código otra vez, para que las decisiones pasen su puerta. Es el servicio de las alertas:
 * comprueba lo reciente con su propia lectura, que pide Finanzas. Un código sin forma no llega al
 * servicio. Verificado, se redirige a esta misma página: recargar no reenvía el código.
 */
export async function alertsCodeAction(previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = alertsCodeOutcome(await giveFinanceCode(jar, code));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * Revisar una alerta, decidir fraude, excluir una cuenta o revertir una exclusión. Las tres
 * últimas van en dos pasos: el primero solo pregunta en su lugar, sin llamar a nadie, y confirmar
 * sin lo que hay que escribir vuelve a preguntar. Lo que sale bien redirige a esta misma página
 * con su aviso (recargar no reenvía); lo demás vuelve a pedir la página: la lista pudo cambiar.
 */
export async function alertsAction(previous: AlertsState, form: FormData): Promise<AlertsState> {
  const request = readAlertsForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  // El aviso con el que se llegó ya se leyó: no vuelve a salir junto a otra respuesta.
  clearNotice(jar);
  const asked = askedBy(request);
  if (asked !== null) return { kind: "confirming", ...asked, drafts: request.drafts, attempt };

  let outcome: AlertsOutcome;
  switch (request.step) {
    case "review":
      outcome = reviewOutcome(await reviewAlert(jar, { alert: request.alert, note: request.drafts.note }));
      break;
    case "fraud":
      outcome = fraudOutcome(await decideFraud(jar, { alert: request.alert, evidence: request.drafts.evidence }));
      break;
    case "exclude":
      outcome = excludeOutcome(
        await excludeAccount(jar, {
          alert: request.alert,
          account: request.account,
          reasonCode: request.drafts.reasonCode,
          reason: request.drafts.reason,
        }),
      );
      break;
    case "revoke":
      outcome = revokeOutcome(await revokeExclusion(jar, { exclusion: request.exclusion, reason: request.drafts.reason }));
      break;
    // Los primeros pasos ya preguntaron arriba.
    default:
      return { kind: "idle" };
  }
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "failed", reason: outcome.reason, step: request.step, alert: request.alert, drafts: request.drafts, attempt };
}
