"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { ROUTES } from "@/services/account/navigation";
import { clearNotice } from "@/services/account/notice";
import { closePeriod, downloadExport, givePeriodsCode, rehearse, requestRollup } from "@/services/periods/periods";

import {
  closeOutcome,
  downloadOutcome,
  periodCodeTarget,
  periodFrom,
  periodsCodeOutcome,
  readPeriodsForm,
  rehearseOutcome,
  rollupOutcome,
  type CloseState,
  type CodeState,
  type DownloadState,
  type PanelState,
  type PeriodOutcome,
} from "./outcomes";

// Las acciones de PA-79 y PA-80 (el panel de un periodo, y su ensayo y cierre; FL-50; T-605). Ninguna
// decide quién puede: el servicio corre la guarda, y la base vuelve a comprobar que quien decide tenga
// finanzas y un código reciente. Aquí se lee qué se pidió, se llama al servicio y se traduce su
// respuesta con la tabla de la pantalla.

/**
 * Dar el código otra vez, para que las decisiones pasen su puerta. Llega atada desde la pantalla a la
 * página de donde se dio (`{ period, page }`), que se revisa: una acción es una puerta pública. Un código
 * sin forma no llega al servicio. Verificado, se redirige a esa página: recargar no reenvía el código.
 */
export async function periodCodeAction(target: unknown, previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = periodsCodeOutcome(await givePeriodsCode(jar, code), periodCodeTarget(target));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/** Pedir el recálculo (PA-79). Lo que sale bien redirige al panel con su aviso; lo demás vuelve a pedir la página. */
export async function panelAction(previous: PanelState, form: FormData): Promise<PanelState> {
  const request = readPeriodsForm(form);
  if (request.step !== "rollup") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  // El aviso con el que se llegó ya se leyó: no vuelve a salir junto a otra respuesta.
  clearNotice(jar);
  const outcome = rollupOutcome(await requestRollup(jar, { period: request.period }), request.period);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "failed", reason: outcome.reason, attempt };
}

/**
 * Ensayar y cerrar (PA-80). Cerrar va en dos pasos: el primero abre el diálogo sin llamar a nadie, y
 * confirmar sin marcar «Entiendo que no se puede deshacer» vuelve a preguntar. Lo que sale bien redirige
 * al cierre con su aviso (recargar no reenvía); lo demás vuelve a pedir la página: el periodo pudo
 * cambiar, y si no se supo, la página dice cómo quedó.
 */
export async function closeAction(previous: CloseState, form: FormData): Promise<CloseState> {
  const request = readPeriodsForm(form);
  if (request.step !== "rehearse" && request.step !== "ask_close" && request.step !== "close") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  clearNotice(jar);
  if (request.step === "ask_close") return { kind: "confirming", period: request.period, missingUnderstood: false, attempt };
  if (request.step === "close" && !request.understood) return { kind: "confirming", period: request.period, missingUnderstood: true, attempt };

  let outcome: PeriodOutcome;
  if (request.step === "rehearse") outcome = rehearseOutcome(await rehearse(jar, { period: request.period }), request.period);
  else outcome = closeOutcome(await closePeriod(jar, { period: request.period }), request.period);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return { kind: "failed", reason: outcome.reason, step: request.step, attempt };
}

/**
 * Descargar la exportación del cierre (PA-80). Llega atada desde la pantalla a su periodo, que se
 * revisa. El archivo vuelve en el estado de esta acción, que es solo suyo: sin JavaScript React manda
 * el estado de una acción dentro de todo formulario ligado a ella, y así no viaja con los demás. No
 * cambia el periodo: no vuelve a pedir la página.
 */
export async function downloadAction(target: unknown, previous: DownloadState, form: FormData): Promise<DownloadState> {
  const request = readPeriodsForm(form);
  if (request.step !== "download") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  clearNotice(jar);
  const period = periodFrom(target);
  if (period === null) return leaveFor(jar, { to: ROUTES.periods, notice: null });
  const outcome = downloadOutcome(await downloadExport(jar, { run: request.run }), period);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  if (outcome.kind === "file") return { kind: "file", filename: outcome.filename, rows: outcome.rows, href: outcome.href, attempt };
  return { kind: "failed", reason: outcome.reason, attempt };
}
