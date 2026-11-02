import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

import { periodOf, type PeriodStatus } from "./panel";

// Las liquidaciones de un periodo (PA-81 mínimo; RF-505, RF-506, RF-508, RN-12, RN-17; FL-51; T-605, cuarta
// solicitud). Quién puede lo decide la base, con la puerta de finanzas; aquí se decide a quién se le pregunta
// qué y en qué orden, como en el panel del periodo (`panel.ts`):
//
//   · La guarda va primero, y solo sigue quien es del equipo con finanzas.
//   · Lo que llega se revisa antes de tocar la base: periodo, identificadores, la huella de lo que se vio y el
//     estado en que se vio. Lo que no tiene forma no llega (`malformed`).
//   · Liberar y soltar llevan la huella de lo que se vio, y retener el estado en que se vio: la base no hace
//     nada distinto de lo que la persona tenía delante (`preview_changed`, `changed`). Decisión de Sergio del
//     2026-10-28, por la revisión independiente del diseño.
//   · **El freno de producción es de la base** (decisión de Sergio del 2026-10-31, T-409): sin una regla de retención
//     vigente, liberar contesta `withholding_rules_missing`, y sin los datos de alguien, `tax_data_missing`. Cuando
//     conteste el contador se cargan filas, sin despliegue.
//   · Anular es solo del bono del fundador hasta PA-83: el servicio lo busca entre los del periodo antes de
//     anularlo (`void_bonus` anula cualquiera).

export const PAYOUT_STATUSES = [
  "calculated",
  "awaiting_invoice",
  "invoice_in_review",
  "invoice_rejected",
  "ready_to_pay",
  "paid",
  "carried_forward",
  "on_hold",
  "payment_returned",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const BONUS_STATUSES = ["proposed", "confirmed", "void"] as const;
export type BonusStatus = (typeof BONUS_STATUSES)[number];

/** Una fila de PA-81: un maestro con liquidación, o (sin liberar) con algo pendiente que liberar le da. */
export interface PayoutRow {
  teacherId: string;
  name: string | null;
  /** Nulo: todavía no tiene liquidación; liberar se la da. */
  payoutId: string | null;
  status: PayoutStatus | null;
  heldFromStatus: PayoutStatus | null;
  holdReason: string | null;
  heldAt: string | null;
  releasedAt: string | null;
  poolCents: number;
  founderBonus: { bonusId: string; status: BonusStatus; amountCents: number; basisCents: number | null } | null;
  manualBonusesCents: number;
  adjustmentsCents: number;
  balanceCents: number;
  /** El bruto: lo del bote, los bonos confirmados, los ajustes y el saldo. */
  subtotalCents: number;
  /** El bruto es lo que liberar (o soltar) escribiría, no lo escrito. */
  estimated: boolean;
  /** Sin liberar: si le toca pagar impuestos y con qué. Nulo si ya se liberó, o si está retenida: se calcula al soltar. */
  taxState: "not_needed" | "ready" | "no_data" | "no_rule" | null;
  /** Por qué está retenida. `tax_data` no detiene la purga de los latidos, y se le puede pasar a una investigación. */
  holdKind: "investigation" | "tax_data" | null;
  /** Si ya capturó sus datos fiscales, sin verlos. */
  hasTaxData: boolean;
  /** Nulos mientras no se puedan saber (sin datos, sin regla, o retenida sin liberar). */
  vatCents: number | null;
  incomeTaxWithheldCents: number | null;
  vatWithheldCents: number | null;
  netCents: number | null;
  /** Si llega a `PAGO_MINIMO`; nulo si el periodo no tiene un mínimo que sirva. */
  reachesMinimum: boolean | null;
  /** Con lo que se suelta, si está retenida. */
  unholdFingerprint: string | null;
  /** Es la liquidación de quien lee: nadie la retiene ni la suelta (T-401). */
  isSelf: boolean;
}

/** PA-81. `period` nulo: la base no tiene ese periodo. */
export type FinancePayouts =
  | { freshCode: boolean; period: null }
  | {
      freshCode: boolean;
      period: {
        periodId: number;
        status: PeriodStatus;
        closedAt: string | null;
        payoutsReleasedAt: string | null;
        paidAt: string | null;
        minimumCents: number | null;
        /** El último cambio a sus liquidaciones o a sus bonos; nulo si no tiene. */
        changedAt: string | null;
      };
      /** Lo que hace falta para liberar; nulo si no se libera (abierto, en cierre o ya liberado). */
      release: { fingerprint: string; pendingFounderBonuses: number } | null;
      payouts: PayoutRow[];
    };

/** Lo que contesta `private.release_payouts()`. */
export const RELEASE_ANSWERS = [
  "released",
  "already_released",
  "not_closed",
  "previous_not_released",
  "founder_bonuses_pending",
  "no_minimum",
  "withholding_rules_missing",
  "tax_data_missing",
  "preview_changed",
  "malformed",
  "forbidden",
  "needs_fresh_code",
] as const;
export type ReleaseAnswer = (typeof RELEASE_ANSWERS)[number];
/** Lo que contesta `private.hold_payout()`. */
export const HOLD_ANSWERS = ["held", "has_tax_data", "under_investigation", "self", "already_held", "changed", "not_holdable", "no_alert", "not_found", "malformed", "forbidden", "needs_fresh_code"] as const;
export type HoldAnswer = (typeof HOLD_ANSWERS)[number];
/** Lo que contesta `private.unhold_payout()`. */
export const UNHOLD_ANSWERS = ["released_from_hold", "self", "not_held", "changed", "tax_data_missing", "withholding_rules_missing", "not_found", "malformed", "forbidden", "needs_fresh_code"] as const;
export type UnholdAnswer = (typeof UNHOLD_ANSWERS)[number];
/** Lo que contesta `private.confirm_founder_bonus()`. */
export const CONFIRM_ANSWERS = ["confirmed", "self", "already_decided", "not_founder", "period_released", "not_found", "malformed", "forbidden", "needs_fresh_code"] as const;
export type ConfirmAnswer = (typeof CONFIRM_ANSWERS)[number];
/** Lo que contesta `private.void_bonus()`; `not_found` también si no es el bono del fundador de ese periodo. */
export const VOID_ANSWERS = ["voided", "self", "already_void", "period_released", "not_found", "malformed", "forbidden", "needs_fresh_code"] as const;
export type VoidAnswer = (typeof VOID_ANSWERS)[number];

export interface Released {
  answer: ReleaseAnswer;
  /** Con `previous_not_released`, el periodo que falta liberar antes. */
  blockingPeriod: number | null;
  /** Con `released`: `paid` si todo quedó acumulado. */
  periodStatus: PeriodStatus | null;
  /** Con `withholding_rules_missing` y `tax_data_missing`, a quién detiene. */
  teachers: string[];
}
export interface HoldDecided {
  answer: HoldAnswer;
  /** Con `changed` y `not_holdable`, el estado en que está. */
  status: PayoutStatus | null;
}
export interface UnholdDecided {
  answer: UnholdAnswer;
  /** Con `released_from_hold`, a dónde volvió (o en qué quedó, si se liberó ahí mismo). */
  to: PayoutStatus | null;
}
export interface ConfirmDecided {
  answer: ConfirmAnswer;
  /** Con `already_decided`, cómo quedó: confirmado o anulado. */
  status: BonusStatus | null;
}

/** Lo que el almacén lanza cuando liberar o soltar no terminaron por una razón con nombre. */
export class PayoutFailure extends Error {
  readonly reason: "timed_out" | "unbalanced";

  constructor(reason: "timed_out" | "unbalanced") {
    super(reason === "timed_out" ? "Liberar pasó del tope de tiempo." : "Lo liberado no cuadró al confirmar.");
    this.name = "PayoutFailure";
    this.reason = reason;
  }
}

/**
 * Lo que este servicio le pregunta a la base, a nombre de las claims que se le pasan. La lectura es nula
 * cuando quien actúa no pasa la puerta del equipo con finanzas. Las decisiones lanzan si la base no contestó
 * algo de su lista: quien llama lo trata como «no se supo».
 */
export interface PayoutStore {
  payouts(claims: VerifiedClaims, period: number): Promise<FinancePayouts | null>;
  release(claims: VerifiedClaims, period: number, seen: string): Promise<Released>;
  hold(claims: VerifiedClaims, payout: string, reason: string, seen: PayoutStatus): Promise<HoldDecided>;
  /** Retener porque le faltan sus datos o su regla. La base comprueba que de verdad le falten. */
  holdForTax(claims: VerifiedClaims, payout: string, seen: PayoutStatus): Promise<HoldDecided>;
  unhold(claims: VerifiedClaims, payout: string, note: string | null, seen: string): Promise<UnholdDecided>;
  confirmFounder(claims: VerifiedClaims, bonus: string): Promise<ConfirmDecided>;
  /** Anula el bono si es el del fundador de ese periodo; si no, `not_found` sin anular nada. */
  voidFounder(claims: VerifiedClaims, period: number, bonus: string, reason: string): Promise<VoidAnswer>;
}

type Refused = { kind: "refused" };
type Unavailable = { kind: "unavailable" };
type Unknown = { kind: "unknown" };
type Malformed = { kind: "malformed" };

export type PayoutsRead = { kind: "payouts"; payouts: FinancePayouts } | { kind: "not_found" } | Unavailable;
export type ReleaseResult =
  | Refused
  | Unavailable
  | Unknown
  | Malformed
  | { kind: "timed_out" }
  | { kind: "unbalanced" }
  | ({ kind: "answered" } & Released);
export type HoldResult = Refused | Unavailable | Unknown | Malformed | ({ kind: "answered" } & HoldDecided);
export type UnholdResult = Refused | Unavailable | Unknown | Malformed | { kind: "timed_out" } | { kind: "unbalanced" } | ({ kind: "answered" } & UnholdDecided);
export type ConfirmResult = Refused | Unavailable | Unknown | Malformed | ({ kind: "answered" } & ConfirmDecided);
export type VoidResult = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: VoidAnswer };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** El tope de un motivo o una nota, el mismo de la base. */
const TEXT_MAX = 2000;

const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);
const fingerprintOf = (value: unknown): string | null => (typeof value === "string" && FINGERPRINT.test(value) ? value : null);
const statusOf = (value: unknown): PayoutStatus | null => PAYOUT_STATUSES.find((each) => each === value) ?? null;
/** Un motivo con algo escrito y dentro del tope, recortado; si no, nulo. */
function reasonOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= TEXT_MAX ? trimmed : null;
}

export interface PayoutsCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  store: PayoutStore;
}

export function createPayoutsPanel(deps: { report: (code: FailureCode) => Promise<void> }, core: PayoutsCore) {
  const { store } = core;

  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "finance")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /** Una decisión: lo que la base contestó, o por qué no se supo. */
  async function decide<Answer>(work: () => Promise<Answer>): Promise<{ ok: true; answer: Answer } | { ok: false; result: Unknown | { kind: "timed_out" } | { kind: "unbalanced" } }> {
    try {
      return { ok: true, answer: await work() };
    } catch (error) {
      if (error instanceof PayoutFailure && error.reason === "timed_out") {
        await deps.report("release_timed_out");
        return { ok: false, result: { kind: "timed_out" } };
      }
      if (error instanceof PayoutFailure) {
        await deps.report("release_unbalanced");
        return { ok: false, result: { kind: "unbalanced" } };
      }
      await deps.report("payout_change_unavailable");
      return { ok: false, result: { kind: "unknown" } };
    }
  }

  /**
   * PA-81: las liquidaciones de un periodo, para la sección que ya pasó su guarda. Leer no pide el código
   * reciente. Una lectura nula no vale: se le vuelve a preguntar a la guarda, y solo si insiste en que pasa con
   * finanzas se reporta.
   */
  async function financePayouts(reader: CookieReader, claims: VerifiedClaims, period: number): Promise<PayoutsRead> {
    const valid = periodOf(period);
    if (valid === null) return { kind: "not_found" };
    let value: FinancePayouts | null;
    try {
      value = await store.payouts(claims, valid);
    } catch {
      await deps.report("payouts_unavailable");
      return { kind: "unavailable" };
    }
    if (value === null) {
      const team = await core.teamStanding(reader);
      if (team.kind === "team" && holds(team.standing, "finance")) await deps.report("payouts_unavailable");
      return { kind: "unavailable" };
    }
    return value.period === null ? { kind: "not_found" } : { kind: "payouts", payouts: value };
  }

  /** Liberar las liquidaciones de un periodo (RF-505) con la huella de lo que se vio. No se deshace. */
  async function releasePayouts(reader: CookieReader, input: { period: unknown; seen: unknown }): Promise<ReleaseResult> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const period = periodOf(input.period);
    const seen = fingerprintOf(input.seen);
    if (period === null || seen === null) return { kind: "malformed" };
    const result = await decide(() => store.release(admitted.claims, period, seen));
    return result.ok ? { kind: "answered", ...result.answer } : result.result;
  }

  /** Retener una liquidación mientras se investiga (RN-17), con su motivo y el estado en que se vio. */
  async function holdPayout(reader: CookieReader, input: { payout: unknown; reason: unknown; seen: unknown }): Promise<HoldResult> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const payout = idOf(input.payout);
    const reason = reasonOf(input.reason);
    const seen = statusOf(input.seen);
    if (payout === null || reason === null || seen === null) return { kind: "malformed" };
    const result = await decide(() => store.hold(admitted.claims, payout, reason, seen));
    // Retener no libera: no vence ni descuadra.
    return result.ok ? { kind: "answered", ...result.answer } : { kind: "unknown" };
  }

  /** Retener porque faltan sus datos o su regla, para liberar a los demás (decisión de Sergio del 2026-10-31). Sin motivo que escribir: lo pone la base. */
  async function holdPayoutForTaxData(reader: CookieReader, input: { payout: unknown; seen: unknown }): Promise<HoldResult> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const payout = idOf(input.payout);
    const seen = statusOf(input.seen);
    if (payout === null || seen === null) return { kind: "malformed" };
    const result = await decide(() => store.holdForTax(admitted.claims, payout, seen));
    // Retener no libera: no vence ni descuadra.
    return result.ok ? { kind: "answered", ...result.answer } : { kind: "unknown" };
  }

  /** Soltar una retenida con la huella de lo que se vio: si estaba calculada en un mes liberado, se libera ahí mismo. */
  async function unholdPayout(reader: CookieReader, input: { payout: unknown; note: unknown; seen: unknown }): Promise<UnholdResult> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const payout = idOf(input.payout);
    const seen = fingerprintOf(input.seen);
    // La nota es opcional; una que pasa del tope no llega.
    const note = typeof input.note === "string" && input.note.trim().length > 0 ? reasonOf(input.note) : "";
    if (payout === null || seen === null || note === null) return { kind: "malformed" };
    const result = await decide(() => store.unhold(admitted.claims, payout, note === "" ? null : note, seen));
    return result.ok ? { kind: "answered", ...result.answer } : result.result;
  }

  /** Confirmar el bono que el cierre propuso a un fundador (RN-12), antes de liberar su periodo. */
  async function confirmFounderBonus(reader: CookieReader, input: { bonus: unknown }): Promise<ConfirmResult> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const bonus = idOf(input.bonus);
    if (bonus === null) return { kind: "malformed" };
    const result = await decide(() => store.confirmFounder(admitted.claims, bonus));
    return result.ok ? { kind: "answered", ...result.answer } : { kind: "unknown" };
  }

  /** Anular el bono del fundador de un periodo, con su motivo, mientras el periodo no se libere. */
  async function voidFounderBonus(reader: CookieReader, input: { period: unknown; bonus: unknown; reason: unknown }): Promise<VoidResult> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const period = periodOf(input.period);
    const bonus = idOf(input.bonus);
    const reason = reasonOf(input.reason);
    if (period === null || bonus === null || reason === null) return { kind: "malformed" };
    const result = await decide(() => store.voidFounder(admitted.claims, period, bonus, reason));
    return result.ok ? { kind: "answered", answer: result.answer } : { kind: "unknown" };
  }

  return { financePayouts, releasePayouts, holdPayout, holdPayoutForTaxData, unholdPayout, confirmFounderBonus, voidFounderBonus };
}
