import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { consentsPath, PAYOUT_PERIOD_SEGMENT, ROUTES, signInPath } from "@/services/account/navigation";
import type { PayoutCsv, TeacherPayoutStatus } from "@/services/teachers/payout-report-data";

import type { Leave } from "../_lib/change";

// La tabla pura de los pagos del maestro (PA-46 y PA-47; T-604, cuarta solicitud): qué nombre, qué tono y qué paso tiene cada estado que ve el maestro,
// qué le toca hacer («Qué sigue», la tabla del diseño de PA-47), y qué hace la acción del CSV con cada respuesta del servicio. No decide nada: el
// estado lo dice la base, y aquí solo se pone en palabras. Un estado nuevo se agrega aquí, no en el componente.

const text = portal.payouts;

export type StatusTone = "neutral" | "active" | "attention" | "good" | "bad";

/** La línea de pasos de PA-47, en orden. */
export type PayoutStep = "calculated" | "awaiting_invoice" | "invoice_in_review" | "ready_to_pay" | "paid";
export const PAYOUT_STEPS: readonly PayoutStep[] = ["calculated", "awaiting_invoice", "invoice_in_review", "ready_to_pay", "paid"];

interface StatusEntry {
  label: string;
  tone: StatusTone;
  /** El paso que se marca en la línea; nulo si el estado no está en ella (acumulada, retenida, en cero). */
  step: PayoutStep | null;
}

/**
 * Cada estado que ve el maestro. Una rechazada vuelve a esperar factura, y un pago devuelto vuelve a estar listo para pago: así lo marca la línea.
 * Retenida (en revisión o por datos fiscales) no marca paso: pudo retenerse en cualquiera (decisión mía sin confirmar).
 */
export const PAYOUT_STATUS: Readonly<Record<TeacherPayoutStatus, StatusEntry>> = {
  empty: { label: text.status.empty, tone: "neutral", step: null },
  calculated: { label: text.status.calculated, tone: "neutral", step: "calculated" },
  awaiting_invoice: { label: text.status.awaitingInvoice, tone: "active", step: "awaiting_invoice" },
  invoice_in_review: { label: text.status.invoiceInReview, tone: "active", step: "invoice_in_review" },
  invoice_rejected: { label: text.status.invoiceRejected, tone: "bad", step: "awaiting_invoice" },
  ready_to_pay: { label: text.status.readyToPay, tone: "active", step: "ready_to_pay" },
  paid: { label: text.status.paid, tone: "good", step: "paid" },
  carried_forward: { label: text.status.carriedForward, tone: "attention", step: null },
  payment_returned: { label: text.status.paymentReturned, tone: "bad", step: "ready_to_pay" },
  in_review: { label: text.status.inReview, tone: "active", step: null },
  tax_data_missing: { label: text.status.taxDataMissing, tone: "attention", step: null },
  tax_data_review: { label: text.status.taxDataReview, tone: "active", step: null },
};

/** Lo que «Qué sigue» necesita saber, ya escrito en pantalla (montos y fechas). */
export interface NextFacts {
  status: TeacherPayoutStatus;
  /** Lo que se factura (el total de la factura, que es el neto); nulo antes de liberar. */
  amount: string | null;
  /** La fecha límite para facturar. */
  dueOn: string | null;
  /** Cuándo se envió la factura que está en revisión. */
  submittedOn: string | null;
  rejectionReason: string | null;
  paidOn: string | null;
  reference: string | null;
  /** Lo que una acumulada pasa al siguiente, sin signo; `against` si va en contra. */
  carried: { amount: string; against: boolean } | null;
}

export interface NextStep {
  text: string;
  /** Sin datos fiscales, el aviso lleva «Capturar datos». */
  taxDataLink: boolean;
}

const say = (value: string): NextStep => ({ text: value, taxDataLink: false });

/** «Qué sigue» de cada estado. Lo que falta de un dato se dice sin él, nunca con un hueco. */
export function nextStep(facts: NextFacts): NextStep {
  const next = text.next;
  switch (facts.status) {
    case "empty":
      return say(next.empty);
    case "calculated":
      return say(next.calculated);
    case "awaiting_invoice":
      if (facts.amount === null) return say(next.awaitingInvoiceBare);
      return say(facts.dueOn === null ? t(next.awaitingInvoiceNoDate, { amount: facts.amount }) : t(next.awaitingInvoice, { amount: facts.amount, date: facts.dueOn }));
    case "invoice_in_review":
      return say(facts.submittedOn === null ? next.invoiceInReviewNoDate : t(next.invoiceInReview, { date: facts.submittedOn }));
    case "invoice_rejected":
      return say(facts.rejectionReason === null ? next.invoiceRejectedNoReason : t(next.invoiceRejected, { reason: facts.rejectionReason }));
    case "ready_to_pay":
      return say(next.readyToPay);
    case "paid":
      return say(facts.paidOn === null || facts.reference === null ? next.paidNoDetail : t(next.paid, { date: facts.paidOn, reference: facts.reference }));
    case "carried_forward":
      if (facts.carried === null) return say(next.carriedNoAmount);
      return say(t(facts.carried.against ? next.carriedAgainst : next.carriedForward, { amount: facts.carried.amount }));
    case "payment_returned":
      return say(next.paymentReturned);
    case "in_review":
      return say(next.inReview);
    case "tax_data_missing":
      return { text: next.taxDataMissing, taxDataLink: true };
    case "tax_data_review":
      return say(next.taxDataReview);
  }
}

/** El aviso de que venció la fecha límite para facturar: se puede facturar igual. */
export function overdueText(dueOn: string | null): string {
  return dueOn === null ? text.next.overdueNoDate : t(text.next.overdue, { date: dueOn });
}

// ---------------------------------------------------------------------------------------
// El CSV de PA-47.

/** El bloque de descargas: sin JavaScript, la respuesta vuelve a él. Vive aquí y no en el componente de cliente, para que la pantalla del servidor lo lea como texto. */
export const DOWNLOAD_BLOCK_ID = "descargas";

/** El botón de «Descargar CSV»: lleva el periodo que se ve («2031-02»). */
export const csvButton = (period: string): string => `csv:${period}`;

/** Lo que pidió el formulario: el periodo, si tiene forma. Lo demás, nada. */
export function readCsvForm(form: FormData): { period: string } | null {
  const value = form.get("do");
  if (typeof value !== "string" || value.length > 16 || !value.startsWith("csv:")) return null;
  const period = value.slice("csv:".length);
  return PAYOUT_PERIOD_SEGMENT.test(period) ? { period } : null;
}

export type CsvFailure = "not_found" | "unavailable";

export type CsvState =
  | { kind: "idle" }
  | { kind: "file"; fileName: string; href: string; attempt: number }
  | { kind: "failed"; reason: CsvFailure; attempt: number };

/** El reporte como dirección de datos: el enlace lo guarda con su nombre, con JavaScript y sin él (el mismo patrón que la exportación del cierre, PA-80). */
export function csvHref(content: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(content)}`;
}

const leave = (to: string, closeSession = false, notice: Leave["notice"] = null): Leave => ({ kind: "leave", to, notice, closeSession });

/**
 * Lo que contestó pedir el CSV. Quien ya no es maestro se vuelve a la pantalla, donde la guarda contesta que no existe; una sesión rechazada, como en
 * las otras acciones del portal (`_lib/change.ts`).
 *
 * @param back La ruta de PA-47 de ese periodo, ya armada.
 */
export function csvOutcome(result: PayoutCsv, back: string): Leave | { kind: "file"; fileName: string; href: string } | { kind: "failed"; reason: CsvFailure } {
  switch (result.kind) {
    case "csv":
      return { kind: "file", fileName: result.fileName, href: csvHref(result.text) };
    case "not_found":
      return { kind: "failed", reason: "not_found" };
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "not_teacher":
      return leave(back);
    case "session":
      switch (result.check.kind) {
        case "anonymous":
          return leave(signInPath(back));
        case "incomplete":
          return leave(consentsPath(back));
        case "suspended":
          // La cuenta suspendida: la página pinta PA-35.
          return leave(back);
        case "unavailable":
          return { kind: "failed", reason: "unavailable" };
        case "must_sign_out":
          return result.check.then === "recover" ? leave(ROUTES.recover, true, "choose_password") : leave(ROUTES.signIn, true);
      }
  }
}
