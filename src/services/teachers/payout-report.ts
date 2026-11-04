import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

// El reporte del maestro (RF-504, RF-505, RF-506, RF-610, RN-15; PA-46 y PA-47; T-604, cuarta solicitud). El maestro lee lo suyo, también suspendido: sus
// liquidaciones, el reporte de un periodo y ese reporte en CSV. Por alumno van el alias y los puntos, nunca los pesos (decisión de Sergio del 2026-11-03):
// con los dos, el maestro deduciría cuánto ve el alumno con otros maestros. Una retenida por una investigación o por un pago que chocó se ve «en revisión»,
// sin motivo. Lo decide la base; aquí se revisa la forma y se traduce el periodo de la dirección.

/** El estado que ve el maestro. Nunca `on_hold`: la base lo traduce. */
export type TeacherPayoutStatus =
  | "empty" | "calculated" | "awaiting_invoice" | "invoice_in_review" | "invoice_rejected" | "ready_to_pay" | "paid" | "carried_forward"
  | "payment_returned" | "in_review" | "tax_data_missing" | "tax_data_review";

/** Una fila de PA-46. `period` es «AAAA-MM». */
export interface PayoutRow {
  period: string;
  status: TeacherPayoutStatus;
  poolCents: number;
  /** Bonos, ajustes y saldo: nulos antes de liberar, porque los escribe liberar. */
  bonusesCents: number | null;
  adjustmentsCents: number | null;
  balanceAppliedCents: number | null;
  /** Solo en lo que se paga y ya se liberó. */
  netCents: number | null;
  /** Lo que una acumulada pasa al siguiente, con signo. */
  carriedCents: number | null;
  invoiceDueOn: string | null;
  overdue: boolean;
  action: "upload_invoice" | null;
}

export interface MyPayouts {
  /** El saldo acumulado; nulo si es cero. */
  balanceCents: number | null;
  /** Si ya existe el RFC de quien recibe (PQ-20): sin él no se puede empezar ninguna factura. */
  receiverReady: boolean;
  periods: PayoutRow[];
}

export interface PayoutMoney {
  poolCents: number;
  bonusesCents: number;
  adjustmentsCents: number;
  balanceAppliedCents: number;
  subtotalCents: number;
  vatCents: number;
  incomeTaxWithheldCents: number;
  vatWithheldCents: number;
  netCents: number;
  bonuses: { kind: "founder" | "open_course" | "discretionary"; amountCents: number }[];
  /** Sin motivo: es texto interno. */
  adjustments: { originPeriod: string; amountCents: number }[];
}

export interface PayoutReportValue {
  period: string;
  status: TeacherPayoutStatus;
  released: boolean;
  invoiceDueOn: string | null;
  overdue: boolean;
  summary: {
    poolCents: number;
    /** Nulo si el periodo no tenía juego de tramos. */
    poolBps: number | null;
    nothingAssigned: boolean;
    assignedCents: number;
    unconsumedCents: number;
    totalCents: number;
    halfPoints: number;
    students: number;
  };
  /** Nulo antes de liberar. */
  money: PayoutMoney | null;
  invoice: {
    /** Nulo mientras no exista (PQ-20). */
    receiverRfc: string | null;
    latest: { status: "in_review" | "accepted" | "rejected"; submittedAt: string; reviewedAt: string | null; rejectionReason: string | null } | null;
  };
  /** El monto es lo transferido. */
  payment: { paidOn: string; reference: string; amountCents: number } | null;
  /** Alias y medios puntos, de más a menos. */
  students: { alias: string; halfPoints: number }[];
}

export type PayoutReportAnswer =
  | { outcome: "ok"; value: PayoutReportValue }
  | { outcome: "empty"; period: string; poolCents: number; poolBps: number | null; nothingAssigned: boolean }
  | { outcome: "not_teacher" | "not_found" };

export type PayoutCsvAnswer = { outcome: "ok"; csv: string } | { outcome: "not_teacher" | "not_found" };

export interface PayoutReportStore {
  mine: (claims: VerifiedClaims) => Promise<{ outcome: "ok"; value: MyPayouts } | { outcome: "not_teacher" }>;
  /** El periodo, como lo guarda la base: AAAAMM. */
  report: (claims: VerifiedClaims, period: number) => Promise<PayoutReportAnswer>;
  csv: (claims: VerifiedClaims, period: number) => Promise<PayoutCsvAnswer>;
}

export interface PayoutReportDeps {
  store: PayoutReportStore;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
}

/** Una lectura de pantalla: lo que contestó la base, o «no se supo». */
export type ReportRead<Value> = { kind: "ready"; value: Value } | { kind: "unavailable" };

type Refused = Exclude<SessionCheck, { kind: "pass" }>;

export type PayoutCsv =
  | { kind: "csv"; fileName: string; text: string }
  | { kind: "not_teacher" | "not_found" | "unavailable" }
  | { kind: "session"; check: Refused };

const PERIOD_SEGMENT = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** El periodo de la dirección («2031-02») como lo guarda la base (203102), o nulo si no tiene forma. */
export function periodFromSegment(segment: unknown): number | null {
  if (typeof segment !== "string") return null;
  const match = PERIOD_SEGMENT.exec(segment);
  if (match === null) return null;
  const year = Number(match[1]);
  return year < 2000 ? null : year * 100 + Number(match[2]);
}

/** El periodo de la base (203102) como va en la dirección y en pantalla («2031-02»). */
export function periodSegment(period: number): string {
  return `${Math.floor(period / 100)}-${String(period % 100).padStart(2, "0")}`;
}

export function createPayoutReports(deps: PayoutReportDeps) {
  const { store, report } = deps;

  async function read<Value>(work: () => Promise<Value>): Promise<ReportRead<Value>> {
    try {
      return { kind: "ready", value: await work() };
    } catch {
      await report("payout_report_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** PA-46, con las claims que la guarda le dio a la página. */
  function myPayouts(claims: VerifiedClaims): Promise<ReportRead<{ outcome: "ok"; value: MyPayouts } | { outcome: "not_teacher" }>> {
    return read(() => store.mine(claims));
  }

  /** PA-47. Un periodo sin forma es como uno que no existe: no se le pregunta a la base. */
  function payoutReport(claims: VerifiedClaims, segment: string): Promise<ReportRead<PayoutReportAnswer>> {
    const period = periodFromSegment(segment);
    if (period === null) return Promise.resolve({ kind: "ready", value: { outcome: "not_found" } });
    return read(() => store.report(claims, period));
  }

  /** El CSV de PA-47, desde su acción: corre la guarda de sesión otra vez. */
  async function payoutReportCsv(reader: CookieReader, segment: unknown): Promise<PayoutCsv> {
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    const period = periodFromSegment(segment);
    if (period === null) return { kind: "not_found" };
    const answer = await read(() => store.csv(check.claims, period));
    if (answer.kind === "unavailable") return { kind: "unavailable" };
    if (answer.value.outcome !== "ok") return { kind: answer.value.outcome };
    return { kind: "csv", fileName: `reporte-${periodSegment(period)}.csv`, text: answer.value.csv };
  }

  return { myPayouts, payoutReport, payoutReportCsv };
}
