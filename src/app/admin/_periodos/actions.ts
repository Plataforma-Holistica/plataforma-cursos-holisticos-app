"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { ROUTES } from "@/services/account/navigation";
import { clearNotice } from "@/services/account/notice";
import {
  closePeriod,
  confirmFounderBonus,
  downloadExport,
  givePeriodsCode,
  holdPayout,
  rehearse,
  releasePayouts,
  requestRollup,
  unholdPayout,
  voidFounderBonus,
} from "@/services/periods/periods";

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
import {
  confirmOutcome,
  holdOutcome,
  payoutsPeriodFrom,
  readPayoutsForm,
  releaseOutcome,
  unholdOutcome,
  voidOutcome,
  type PayoutOutcome,
  type PayoutsState,
} from "./payouts-outcomes";

// Las acciones de PA-79, PA-80 y PA-81 (el panel de un periodo, su ensayo y cierre, y sus liquidaciones;
// FL-50 y FL-51; T-605). Ninguna
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
  if (request.step === "ask_close") return { kind: "confirming", period: request.period, run: request.run, missingUnderstood: false, attempt };
  if (request.step === "close" && !request.understood) return { kind: "confirming", period: request.period, run: request.run, missingUnderstood: true, attempt };

  let outcome: PeriodOutcome;
  if (request.step === "rehearse") outcome = rehearseOutcome(await rehearse(jar, { period: request.period }), request.period);
  else outcome = closeOutcome(await closePeriod(jar, { period: request.period, run: request.run }), request.period);
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

/**
 * Las liquidaciones de un periodo (PA-81): liberar, retener, soltar, y confirmar o anular el bono del fundador.
 * El periodo llega atado desde la pantalla, y se revisa; del formulario llega qué botón, con lo que se vio, y lo
 * escrito. El primer paso de liberar, retener, soltar y anular no llama a nadie; confirmar sin la casilla o sin
 * el motivo vuelve a preguntar. Lo que sale bien redirige a la página con su aviso; lo demás la vuelve a pedir:
 * las liquidaciones pudieron cambiar.
 */
export async function payoutsAction(target: unknown, previous: PayoutsState, form: FormData): Promise<PayoutsState> {
  const request = readPayoutsForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  clearNotice(jar);
  const bound = payoutsPeriodFrom(target);
  if ("leave" in bound) return leaveFor(jar, bound.leave);
  const { period } = bound;

  let outcome: PayoutOutcome;
  switch (request.step) {
    case "ask_release":
      return { kind: "asking", ask: { what: "release", seen: request.seen }, missing: null, attempt };
    case "release":
      if (!request.understood) return { kind: "asking", ask: { what: "release", seen: request.seen }, missing: "understood", attempt };
      outcome = releaseOutcome(await releasePayouts(jar, { period, seen: request.seen }), period);
      break;
    case "ask_hold":
      return { kind: "asking", ask: { what: "hold", payout: request.payout, status: request.status }, missing: null, attempt };
    case "hold":
      if (request.reason === "") return { kind: "asking", ask: { what: "hold", payout: request.payout, status: request.status }, missing: "reason", attempt };
      outcome = holdOutcome(await holdPayout(jar, { payout: request.payout, reason: request.reason, seen: request.status }), period);
      break;
    case "ask_unhold":
      return { kind: "asking", ask: { what: "unhold", payout: request.payout, seen: request.seen }, missing: null, attempt };
    case "unhold":
      if (request.releases && !request.understood) return { kind: "asking", ask: { what: "unhold", payout: request.payout, seen: request.seen }, missing: "understood", attempt };
      outcome = unholdOutcome(await unholdPayout(jar, { payout: request.payout, note: request.note, seen: request.seen }), period);
      break;
    case "confirm_bonus":
      outcome = confirmOutcome(await confirmFounderBonus(jar, { bonus: request.bonus }), period);
      break;
    case "ask_void":
      return { kind: "asking", ask: { what: "void", bonus: request.bonus }, missing: null, attempt };
    case "void":
      if (request.reason === "") return { kind: "asking", ask: { what: "void", bonus: request.bonus }, missing: "reason", attempt };
      outcome = voidOutcome(await voidFounderBonus(jar, { period, bonus: request.bonus, reason: request.reason }), period);
      break;
  }
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  refresh();
  return outcome.detail === undefined ? { kind: "failed", reason: outcome.reason, attempt } : { kind: "failed", reason: outcome.reason, detail: outcome.detail, attempt };
}
