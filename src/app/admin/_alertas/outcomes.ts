import { ROUTES } from "@/services/account/navigation";
import type { AccountExcluded, AlertReviewed, ExclusionRevoked, FinanceCode } from "@/services/anomalies/anomalies";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace PA-68 mínima (las alertas de anomalía; FL-64; T-208). Todo aquí es puro:
// el servicio corre la guarda y le pregunta a la base, y esto traduce su respuesta a un destino o
// a lo que se pinta. Cada respuesta tiene su caso: una nueva no compila sin el suyo.
//
// Las reglas de las demás secciones valen aquí igual:
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene finanzas
//     (`forbidden`), se le manda a esta misma página, donde decide su guarda.
//   · Lo que llega es qué botón se pulsó y lo escrito en su formulario. Un envío sin intención, con
//     más de una o con un identificador sin forma cuenta como vacío. De qué alerta, de qué cuenta
//     y de qué exclusión, sale del valor del botón; la cuenta, como su huella en esa alerta.
//   · Lo que sale bien redirige a esta página con su aviso: sin JavaScript, recargar no reenvía.
//   · «No se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor.

export type { CodeState } from "../_lib/fresh-code";

/** A esta misma página: decide su guarda. */
const TO_PAGE: Leave = { kind: "leave", to: ROUTES.alerts, notice: null };
const done = (notice: "alert_reviewed" | "fraud_decided" | "account_excluded" | "exclusion_revoked"): Leave => ({
  kind: "leave",
  to: ROUTES.alerts,
  notice,
});

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[0-9a-f]{12}$/;
const MAX_INTENT = 120;
/** Lo que se lee de un campo de texto: un poco más que el tope de la base, para que la base lo rechace y no se corte en silencio. */
const MAX_TEXT_READ = 4_100;

/** Lo que contestó dar el código: la tabla compartida, con esta página. */
export function alertsCodeOutcome(result: FinanceCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.alerts);
}

// ---------------------------------------------------------------------------------------
// Lo que llega.

/** Lo escrito en el formulario, tal como llegó: se vuelve a pintar si hay que repetir. */
export interface Drafts {
  note?: string;
  evidence?: string;
  reason?: string;
  reasonCode?: string;
}

export type AlertsRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "review"; alert: string; drafts: Drafts }
  | { step: "ask_fraud"; alert: string; drafts: Drafts }
  | { step: "fraud"; alert: string; drafts: Drafts }
  | { step: "ask_exclude"; alert: string; account: string; drafts: Drafts }
  | { step: "exclude"; alert: string; account: string; drafts: Drafts }
  | { step: "ask_revoke"; alert: string; exclusion: string; drafts: Drafts }
  | { step: "revoke"; alert: string; exclusion: string; drafts: Drafts };

/** Un campo de texto: lo que llegó, si es texto, cortado a lo que se lee. */
function textOf(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, MAX_TEXT_READ) : undefined;
}

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readAlertsForm(form: unknown): AlertsRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, alert, target, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (verb === "cancel" && alert === undefined) return { step: "cancel" };
  if (alert === undefined || !ID.test(alert)) return { step: "none" };
  const drafts: Drafts = {
    note: textOf(form, "note"),
    evidence: textOf(form, "evidence"),
    reason: textOf(form, "reason"),
    reasonCode: textOf(form, "reason_code"),
  };
  if (target === undefined) {
    if (verb === "review") return { step: "review", alert, drafts };
    if (verb === "ask_fraud") return { step: "ask_fraud", alert, drafts };
    if (verb === "fraud") return { step: "fraud", alert, drafts };
    return { step: "none" };
  }
  if ((verb === "ask_exclude" || verb === "exclude") && ACCOUNT.test(target)) return { step: verb, alert, account: target, drafts };
  if ((verb === "ask_revoke" || verb === "revoke") && ID.test(target)) return { step: verb, alert, exclusion: target, drafts };
  return { step: "none" };
}

/** Los valores de los botones. Los arma esta tabla y los lee `readAlertsForm`. */
export const alertsButton = {
  review: (alert: string) => `review:${alert}`,
  askFraud: (alert: string) => `ask_fraud:${alert}`,
  fraud: (alert: string) => `fraud:${alert}`,
  askExclusion: (alert: string, account: string) => `ask_exclude:${alert}:${account}`,
  exclude: (alert: string, account: string) => `exclude:${alert}:${account}`,
  askRevocation: (alert: string, exclusion: string) => `ask_revoke:${alert}:${exclusion}`,
  revoke: (alert: string, exclusion: string) => `revoke:${alert}:${exclusion}`,
  cancel: () => "cancel",
} as const;

// ---------------------------------------------------------------------------------------
// Lo que se pinta.

export type AlertsFailure =
  | "needs_code"
  | "missing_note"
  | "missing_evidence"
  | "missing_reason"
  | "already_reviewed"
  | "already_fraud"
  | "already_excluded"
  | "already_revoked"
  | "closed"
  | "needs_fraud_decision"
  /** La alerta o la cuenta es de quien actúa (T-401). */
  | "self"
  /** Quien marcó el fraude no excluye por fraude: otra persona de finanzas. */
  | "proposer"
  /** Quien cobra en ese periodo no excluye ni revierte en él. */
  | "conflict"
  | "not_found"
  | "unavailable"
  | "unknown";

/** Qué se está preguntando, y dónde: en la alerta, en la fila de una cuenta o en la de una exclusión. */
export type Confirming =
  | { step: "fraud"; alert: string }
  | { step: "exclude"; alert: string; account: string }
  | { step: "revoke"; alert: string; exclusion: string };

/** Lo que falta escribir para confirmar: se dice en la pregunta, que sigue abierta. */
export type ConfirmProblem = "missing_evidence" | "missing_reason";

/** Lo que la lista pinta después de un envío. */
export type AlertsState =
  | { kind: "idle" }
  /**
   * Se pregunta en su lugar: el primer paso, sin haber llamado a nadie, o un confirmar al que le
   * falta algo escrito. Lo escrito se conserva.
   */
  | { kind: "confirming"; confirming: Confirming; drafts: Drafts; problem: ConfirmProblem | null; attempt: number }
  /** Qué paso falló: lo escrito en la nota vuelve a su campo solo si falló revisar. */
  | { kind: "failed"; reason: AlertsFailure; step: DecisionStep; alert: string | null; drafts: Drafts; attempt: number };

/** Los pasos que llegan al servicio. */
export type DecisionStep = "review" | "fraud" | "exclude" | "revoke";

export type AlertsOutcome = Leave | { kind: "failed"; reason: AlertsFailure };

const written = (value: string | undefined) => value !== undefined && value.trim() !== "";

/**
 * Qué se pregunta con cada paso, o nulo si el paso no pregunta nada. El primero pregunta sin
 * problema; confirmar sin lo que hay que escribir vuelve a preguntar, con lo que falta, sin
 * llamar al servicio. Qué motivo de la lista vale lo revisa el servicio: aquí solo que se eligió uno.
 */
export function askedBy(request: AlertsRequest): { confirming: Confirming; problem: ConfirmProblem | null } | null {
  switch (request.step) {
    case "ask_fraud":
      return { confirming: { step: "fraud", alert: request.alert }, problem: null };
    case "ask_exclude":
      return { confirming: { step: "exclude", alert: request.alert, account: request.account }, problem: null };
    case "ask_revoke":
      return { confirming: { step: "revoke", alert: request.alert, exclusion: request.exclusion }, problem: null };
    case "fraud":
      return written(request.drafts.evidence) ? null : { confirming: { step: "fraud", alert: request.alert }, problem: "missing_evidence" };
    case "exclude":
      return written(request.drafts.reason) && written(request.drafts.reasonCode)
        ? null
        : { confirming: { step: "exclude", alert: request.alert, account: request.account }, problem: "missing_reason" };
    case "revoke":
      return written(request.drafts.reason)
        ? null
        : { confirming: { step: "revoke", alert: request.alert, exclusion: request.exclusion }, problem: "missing_reason" };
    case "none":
    case "cancel":
    case "review":
      return null;
  }
}

/** Lo que contestó revisar una alerta. */
export function reviewOutcome(result: AlertReviewed): AlertsOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "malformed":
      return { kind: "failed", reason: "missing_note" };
    case "answered":
      switch (result.answer) {
        case "reviewed":
          return done("alert_reviewed");
        // Revisar no decide fraude: si contestara esto, la alerta ya estaba revisada.
        case "marked_fraud":
        case "already_reviewed":
          return { kind: "failed", reason: "already_reviewed" };
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "malformed":
          return { kind: "failed", reason: "missing_note" };
        case "self":
          return { kind: "failed", reason: "self" };
        case "not_found":
          return { kind: "failed", reason: "not_found" };
      }
  }
}

/** Lo que contestó decidir fraude. `already_reviewed` aquí es que ya estaba decidida como fraude. */
export function fraudOutcome(result: AlertReviewed): AlertsOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "malformed":
      return { kind: "failed", reason: "missing_evidence" };
    case "answered":
      switch (result.answer) {
        // No llega: la pantalla solo ofrece decidir fraude con la alerta ya revisada, y con la
        // alerta abierta la base pide la nota (contesta `malformed`). Si llegara, la base la revisó
        // y la decidió como fraude en el mismo cambio.
        case "reviewed":
        case "marked_fraud":
          return done("fraud_decided");
        case "already_reviewed":
          return { kind: "failed", reason: "already_fraud" };
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "malformed":
          return { kind: "failed", reason: "missing_evidence" };
        case "self":
          return { kind: "failed", reason: "self" };
        case "not_found":
          return { kind: "failed", reason: "not_found" };
      }
  }
}

/** Lo que contestó excluir una cuenta. */
export function excludeOutcome(result: AccountExcluded): AlertsOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "malformed":
      return { kind: "failed", reason: "missing_reason" };
    case "answered":
      switch (result.answer) {
        case "excluded":
          return done("account_excluded");
        case "already_excluded":
          return { kind: "failed", reason: "already_excluded" };
        case "outside_window":
          return { kind: "failed", reason: "closed" };
        case "needs_fraud_decision":
          return { kind: "failed", reason: "needs_fraud_decision" };
        case "self":
          return { kind: "failed", reason: "self" };
        case "proposer":
          return { kind: "failed", reason: "proposer" };
        case "conflict":
          return { kind: "failed", reason: "conflict" };
        // Una cuenta que no es de la alerta solo llega con un formulario armado a mano.
        case "not_related":
        case "not_found":
          return { kind: "failed", reason: "not_found" };
        case "malformed":
          return { kind: "failed", reason: "missing_reason" };
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
      }
  }
}

/** Lo que contestó revertir una exclusión. */
export function revokeOutcome(result: ExclusionRevoked): AlertsOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "malformed":
      return { kind: "failed", reason: "missing_reason" };
    case "answered":
      switch (result.answer) {
        case "revoked":
          return done("exclusion_revoked");
        case "already_revoked":
          return { kind: "failed", reason: "already_revoked" };
        case "outside_window":
          return { kind: "failed", reason: "closed" };
        case "self":
          return { kind: "failed", reason: "self" };
        case "conflict":
          return { kind: "failed", reason: "conflict" };
        case "not_found":
          return { kind: "failed", reason: "not_found" };
        case "malformed":
          return { kind: "failed", reason: "missing_reason" };
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
      }
  }
}
