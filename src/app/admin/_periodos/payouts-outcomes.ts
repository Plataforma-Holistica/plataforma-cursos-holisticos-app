import { periodPayoutsPath, ROUTES } from "@/services/account/navigation";
import type { ConfirmResult, HoldResult, PayoutStatus, ReleaseResult, UnholdResult, VoidResult } from "@/services/periods/periods";

import type { Leave } from "../_lib/fresh-code";
import { periodFrom, UNDERSTOOD } from "./outcomes";

// Qué pinta y qué hace PA-81 (las liquidaciones de un periodo; FL-51; T-605, cuarta solicitud). Todo aquí es
// puro: el servicio corre la guarda y le pregunta a la base, y esto traduce su respuesta a un destino o a lo
// que se pinta. Cada respuesta tiene su caso: una nueva no compila sin el suyo. Las reglas de PA-79 y PA-80
// (`outcomes.ts`) valen aquí igual, más dos:
//
//   · Lo que llega es qué botón se pulsó, con lo que se vio: liberar lleva la huella de la vista, retener el
//     estado de la fila, soltar la huella de la fila. Si la base dice que cambió, la página se vuelve a leer y
//     lo dice. Nadie libera, retiene ni suelta algo distinto de lo que tenía delante.
//   · Liberar, soltar, retener y anular van en dos pasos: el primero no llama a nadie. Liberar y soltar una
//     que se libera ahí mismo piden marcar «Entiendo que no se puede deshacer»; retener y anular, un motivo.
//
// Viaja al navegador: no importa nada del servidor.

const MAX_INTENT = 160;
/** El tope de un motivo o una nota, el mismo de la base. */
export const TEXT_MAX = 2000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PERIOD = /^2\d{3}(0[1-9]|1[0-2])$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const STATUSES: readonly PayoutStatus[] = [
  "calculated",
  "awaiting_invoice",
  "invoice_in_review",
  "invoice_rejected",
  "ready_to_pay",
  "paid",
  "carried_forward",
  "on_hold",
  "payment_returned",
];

const toPage = (period: number): Leave => ({ kind: "leave", to: periodPayoutsPath(period), notice: null });
const updated = (period: number): Leave => ({ kind: "leave", to: periodPayoutsPath(period), notice: "payouts_updated" });

// ---------------------------------------------------------------------------------------
// Lo que llega.

export type PayoutsRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "ask_release"; period: number; seen: string }
  | { step: "release"; period: number; seen: string; understood: boolean }
  | { step: "ask_hold"; payout: string; status: PayoutStatus }
  | { step: "hold"; payout: string; status: PayoutStatus; reason: string }
  | { step: "ask_unhold"; payout: string; seen: string }
  /** `releases`: soltarla la libera ahí mismo, y pide la casilla. Lo dice el botón, que arma la página. */
  | { step: "unhold"; payout: string; seen: string; releases: boolean; note: string; understood: boolean }
  | { step: "confirm_bonus"; bonus: string }
  | { step: "ask_void"; bonus: string }
  | { step: "void"; bonus: string; reason: string };

/** Un campo de texto del formulario, recortado. Lo que no es texto o pasa del tope cuenta como vacío. */
function textOf(form: FormData, name: string): string {
  const values = form.getAll(name);
  const [only] = values;
  if (values.length !== 1 || typeof only !== "string" || only.length > TEXT_MAX) return "";
  return only.trim();
}

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readPayoutsForm(form: unknown): PayoutsRequest {
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, target, shown, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (verb === "cancel") return target === undefined ? { step: "cancel" } : { step: "none" };
  if (target === undefined) return { step: "none" };
  const understood = form.get("understood") === UNDERSTOOD;
  switch (verb) {
    case "ask_release":
    case "release": {
      if (!PERIOD.test(target) || shown === undefined || !FINGERPRINT.test(shown)) return { step: "none" };
      return verb === "ask_release" ? { step: verb, period: Number(target), seen: shown } : { step: verb, period: Number(target), seen: shown, understood };
    }
    case "ask_hold":
    case "hold": {
      const status = STATUSES.find((each) => each === shown);
      if (!ID.test(target) || status === undefined) return { step: "none" };
      return verb === "ask_hold" ? { step: verb, payout: target, status } : { step: verb, payout: target, status, reason: textOf(form, "reason") };
    }
    case "ask_unhold":
    case "unhold":
    case "unhold_release": {
      if (!ID.test(target) || shown === undefined || !FINGERPRINT.test(shown)) return { step: "none" };
      if (verb === "ask_unhold") return { step: verb, payout: target, seen: shown };
      return { step: "unhold", payout: target, seen: shown, releases: verb === "unhold_release", note: textOf(form, "note"), understood };
    }
    case "confirm_bonus":
    case "ask_void":
    case "void": {
      if (!ID.test(target) || shown !== undefined) return { step: "none" };
      if (verb === "void") return { step: verb, bonus: target, reason: textOf(form, "reason") };
      return { step: verb, bonus: target };
    }
    default:
      return { step: "none" };
  }
}

/** Los valores de los botones. Los arma esta tabla y los lee `readPayoutsForm`. */
export const payoutsButton = {
  askRelease: (period: number, seen: string) => `ask_release:${period}:${seen}`,
  release: (period: number, seen: string) => `release:${period}:${seen}`,
  askHold: (payout: string, status: PayoutStatus) => `ask_hold:${payout}:${status}`,
  hold: (payout: string, status: PayoutStatus) => `hold:${payout}:${status}`,
  askUnhold: (payout: string, seen: string) => `ask_unhold:${payout}:${seen}`,
  unhold: (payout: string, seen: string, releases: boolean) => `${releases ? "unhold_release" : "unhold"}:${payout}:${seen}`,
  confirmBonus: (bonus: string) => `confirm_bonus:${bonus}`,
  askVoid: (bonus: string) => `ask_void:${bonus}`,
  void: (bonus: string) => `void:${bonus}`,
  cancel: () => "cancel",
} as const;

// ---------------------------------------------------------------------------------------
// Lo que se pinta.

export type PayoutFailure =
  | "needs_code"
  | "not_enabled"
  | "preview_changed"
  | "changed"
  | "already_released"
  | "not_closed"
  | "previous_not_released"
  | "founder_pending"
  | "no_minimum"
  | "already_held"
  | "not_holdable"
  | "not_held"
  | "already_confirmed"
  | "already_void"
  | "period_released"
  | "not_found"
  | "timed_out"
  | "unbalanced"
  | "unavailable"
  | "unknown";

/** Lo que una respuesta que no salió bien trae para decirse: el periodo que falta liberar, o el estado de la fila. */
export interface FailureDetail {
  period?: number;
  status?: PayoutStatus;
}

export type PayoutOutcome = Leave | { kind: "failed"; reason: PayoutFailure; detail?: FailureDetail };

/** Qué se está preguntando: el primer paso de liberar, retener, soltar o anular. */
export type PayoutAsk =
  | { what: "release"; seen: string }
  | { what: "hold"; payout: string; status: PayoutStatus }
  | { what: "unhold"; payout: string; seen: string }
  | { what: "void"; bonus: string };

/** Lo que pinta PA-81 después de un envío. */
export type PayoutsState =
  | { kind: "idle" }
  /** Un diálogo o un motivo abierto: el primer paso, o confirmar sin la casilla o sin el motivo. */
  | { kind: "asking"; ask: PayoutAsk; missing: "understood" | "reason" | null; attempt: number }
  | { kind: "failed"; reason: PayoutFailure; detail?: FailureDetail; attempt: number };

const failed = (reason: PayoutFailure, detail?: FailureDetail): PayoutOutcome => (detail === undefined ? { kind: "failed", reason } : { kind: "failed", reason, detail });

/** Lo que contestó liberar. */
export function releaseOutcome(result: ReleaseResult, period: number): PayoutOutcome {
  switch (result.kind) {
    case "refused":
      return toPage(period);
    case "unavailable":
      return failed("unavailable");
    case "not_enabled":
      return failed("not_enabled");
    case "timed_out":
      return failed("timed_out");
    case "unbalanced":
      return failed("unbalanced");
    // Una huella o un periodo sin forma solo llegan con un formulario armado a mano.
    case "malformed":
    case "unknown":
      return failed("unknown");
    case "answered":
      switch (result.answer) {
        case "released":
          return { kind: "leave", to: periodPayoutsPath(period), notice: "payouts_released" };
        case "already_released":
          return failed("already_released");
        case "not_closed":
          return failed("not_closed");
        case "previous_not_released":
          return result.blockingPeriod === null ? failed("previous_not_released") : failed("previous_not_released", { period: result.blockingPeriod });
        case "founder_bonuses_pending":
          return failed("founder_pending");
        case "no_minimum":
          return failed("no_minimum");
        case "preview_changed":
          return failed("preview_changed");
        case "forbidden":
          return toPage(period);
        case "needs_fresh_code":
          return failed("needs_code");
        case "malformed":
          return failed("unknown");
      }
  }
}

/** Lo que contestó retener. */
export function holdOutcome(result: HoldResult, period: number): PayoutOutcome {
  switch (result.kind) {
    case "refused":
      return toPage(period);
    case "unavailable":
      return failed("unavailable");
    case "malformed":
    case "unknown":
      return failed("unknown");
    case "answered":
      switch (result.answer) {
        case "held":
          return updated(period);
        case "already_held":
          return failed("already_held");
        case "changed":
          return failed("changed");
        case "not_holdable":
          return result.status === null ? failed("not_holdable") : failed("not_holdable", { status: result.status });
        case "not_found":
          return failed("not_found");
        case "forbidden":
          return toPage(period);
        case "needs_fresh_code":
          return failed("needs_code");
        // La pantalla no manda alerta: solo con un formulario armado a mano.
        case "no_alert":
        case "malformed":
          return failed("unknown");
      }
  }
}

/** Lo que contestó soltar. */
export function unholdOutcome(result: UnholdResult, period: number): PayoutOutcome {
  switch (result.kind) {
    case "refused":
      return toPage(period);
    case "unavailable":
      return failed("unavailable");
    case "timed_out":
      return failed("timed_out");
    case "unbalanced":
      return failed("unbalanced");
    case "malformed":
    case "unknown":
      return failed("unknown");
    case "answered":
      switch (result.answer) {
        case "released_from_hold":
          return updated(period);
        case "not_held":
          return failed("not_held");
        case "changed":
          return failed("changed");
        case "not_found":
          return failed("not_found");
        case "forbidden":
          return toPage(period);
        case "needs_fresh_code":
          return failed("needs_code");
        case "malformed":
          return failed("unknown");
      }
  }
}

/** Lo que contestó confirmar el bono del fundador. */
export function confirmOutcome(result: ConfirmResult, period: number): PayoutOutcome {
  switch (result.kind) {
    case "refused":
      return toPage(period);
    case "unavailable":
      return failed("unavailable");
    case "malformed":
    case "unknown":
      return failed("unknown");
    case "answered":
      switch (result.answer) {
        case "confirmed":
          return updated(period);
        // Ya decidido: puede ser confirmado o anulado, y no son lo mismo.
        case "already_decided":
          return failed(result.status === "void" ? "already_void" : "already_confirmed");
        case "period_released":
          return failed("period_released");
        case "not_found":
          return failed("not_found");
        case "forbidden":
          return toPage(period);
        case "needs_fresh_code":
          return failed("needs_code");
        // La pantalla solo ofrece confirmar el del fundador.
        case "not_founder":
        case "malformed":
          return failed("unknown");
      }
  }
}

/** Lo que contestó anular el bono del fundador. */
export function voidOutcome(result: VoidResult, period: number): PayoutOutcome {
  switch (result.kind) {
    case "refused":
      return toPage(period);
    case "unavailable":
      return failed("unavailable");
    case "malformed":
    case "unknown":
      return failed("unknown");
    case "answered":
      switch (result.answer) {
        case "voided":
          return updated(period);
        case "already_void":
          return failed("already_void");
        case "period_released":
          return failed("period_released");
        case "not_found":
          return failed("not_found");
        case "forbidden":
          return toPage(period);
        case "needs_fresh_code":
          return failed("needs_code");
        case "malformed":
          return failed("unknown");
      }
  }
}

/** El periodo atado a la acción desde la pantalla, o nulo; sin él, la acción va a la lista de periodos. */
export function payoutsPeriodFrom(target: unknown): { period: number } | { leave: Leave } {
  const period = periodFrom(target);
  return period === null ? { leave: { kind: "leave", to: ROUTES.periods, notice: null } } : { period };
}
