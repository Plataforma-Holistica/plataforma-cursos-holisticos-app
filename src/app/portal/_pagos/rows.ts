// El mismo formato de pesos, porcentaje y mes que las liquidaciones de administración (PA-81).
import { money, percent, periodName } from "@/app/admin/_periodos/rows";
import { longDate, longDay } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { portalPayoutPath, ROUTES } from "@/services/account/navigation";
import type { MyPayouts, PayoutMoney, PayoutReportValue, PayoutRow, TeacherPayoutStatus } from "@/services/teachers/payout-report-data";

import { nextStep, overdueText, PAYOUT_STATUS, PAYOUT_STEPS, type NextStep, type PayoutStep, type StatusTone } from "./outcomes";

// Lo que PA-46 y PA-47 pintan, ya en palabras (T-604, cuarta solicitud). Lo arma la página con lo que leyó: el componente no lee centavos ni fechas.
// Por alumno van el alias y los puntos, nunca pesos: los pesos van solo en el bote sin consumo y en el total (decisión de Sergio del 2026-11-03).

const text = portal.payouts;

/** Medios puntos (nunca negativos) como puntos: 3 es «1.5», 4 es «2». Igual que el CSV (`private.csv_half_points`). */
export function points(halfPoints: number): string {
  return `${Math.floor(halfPoints / 2)}${halfPoints % 2 === 0 ? "" : ".5"}`;
}

/** «2031-02» como «Febrero de 2031». */
export function periodTitle(segment: string): string {
  const name = periodName(Number(segment.replace("-", "")));
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export interface StatusView {
  label: string;
  tone: StatusTone;
}

const statusOf = (status: TeacherPayoutStatus): StatusView => ({ label: PAYOUT_STATUS[status].label, tone: PAYOUT_STATUS[status].tone });

// ---------------------------------------------------------------------------------------
// PA-46.

export interface PayoutRowView {
  key: string;
  period: string;
  href: string;
  status: StatusView;
  /** La frase de la acumulada («Pasa a tu siguiente pago: …»), bajo su etiqueta. */
  carried: string | null;
  pool: string;
  extras: string;
  net: string;
  /** «Ya puedes facturar», que abre PA-47 (la subida llega con la siguiente solicitud). */
  canInvoice: boolean;
  overdue: boolean;
}

export interface PayoutsView {
  /** El saldo acumulado, con su frase; nulo si es cero. */
  balance: { amount: string; context: string } | null;
  /** Alguna liquidación espera los datos fiscales del maestro. */
  taxDataMissing: boolean;
  rows: PayoutRowView[];
}

function carriedText(cents: number | null): string | null {
  if (cents === null) return null;
  return cents < 0 ? t(text.carriedAgainst, { amount: money(-cents) }) : t(text.carriedOn, { amount: money(cents) });
}

function payoutRowView(row: PayoutRow): PayoutRowView {
  const empty = row.status === "empty";
  return {
    key: row.period,
    period: periodTitle(row.period),
    href: portalPayoutPath(row.period) ?? ROUTES.portalPayouts,
    status: statusOf(row.status),
    carried: carriedText(row.carriedCents),
    pool: money(row.poolCents),
    extras: money(row.bonusesCents + row.adjustmentsCents),
    // Un periodo en cero se muestra en cero, también el neto.
    net: row.netCents !== null ? money(row.netCents) : empty ? money(0) : text.netPending,
    canInvoice: row.action === "upload_invoice",
    overdue: row.overdue,
  };
}

/** PA-46: la más reciente primero, en la tabla y en las tarjetas. */
export function payoutsView(read: MyPayouts): PayoutsView {
  const rows = [...read.periods].sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0)).map(payoutRowView);
  return {
    balance:
      read.balanceCents === null
        ? null
        : { amount: money(Math.abs(read.balanceCents)), context: read.balanceCents < 0 ? text.balanceAgainst : text.balanceOn },
    taxDataMissing: read.periods.some((row) => row.status === "tax_data_missing"),
    rows,
  };
}

// ---------------------------------------------------------------------------------------
// PA-47.

export interface MoneyLine {
  key: string;
  label: string;
  amount: string;
  /** Las líneas del total (bruto y neto) van separadas y en negritas. */
  total?: boolean;
}

export interface ReportView {
  period: string;
  title: string;
  status: StatusView;
  /** El paso marcado de la línea; nulo si este estado no va en ella (entonces la línea no se pinta). */
  step: PayoutStep | null;
  steps: readonly { step: PayoutStep; label: string }[];
  next: NextStep;
  overdue: string | null;
  summary: { pool: string; poolBps: string; share: string; nothingAssigned: boolean };
  /** Nulo antes de liberar: sin neto. */
  money: MoneyLine[] | null;
  /** Nulo si no toca facturar (antes de liberar, acumulada, sin datos fiscales). */
  invoice: {
    receiverRfc: string | null;
    amounts: { key: string; label: string; amount: string }[];
    latest: { status: string; submitted: string; reviewed: string | null; reason: string | null } | null;
  } | null;
  payment: { paidOn: string; reference: string; amount: string } | null;
  /** Alias y puntos: ningún peso por alumno. */
  students: { key: string; alias: string; points: string }[];
  unconsumed: string;
  totalPoints: string;
  total: string;
}

const STEPS = PAYOUT_STEPS.map((step) => ({ step, label: PAYOUT_STATUS[step].label }));

const BONUS_LABEL = { founder: text.lines.founder, open_course: text.lines.openCourse, discretionary: text.lines.discretionary } as const;

function moneyLines(value: PayoutMoney): MoneyLine[] {
  return [
    { key: "pool", label: text.lines.pool, amount: money(value.poolCents) },
    ...value.bonuses.map((bonus, index) => ({ key: `bono-${index}`, label: BONUS_LABEL[bonus.kind], amount: money(bonus.amountCents) })),
    ...value.adjustments.map((adjustment, index) => ({
      key: `ajuste-${index}`,
      label: t(text.lines.adjustment, { period: periodName(Number(adjustment.originPeriod.replace("-", ""))) }),
      amount: money(adjustment.amountCents),
    })),
    ...(value.balanceAppliedCents === 0 ? [] : [{ key: "saldo", label: text.lines.balance, amount: money(value.balanceAppliedCents) }]),
    { key: "bruto", label: text.lines.subtotal, amount: money(value.subtotalCents), total: true },
    { key: "iva", label: text.lines.vat, amount: money(value.vatCents) },
    { key: "retenciones", label: text.lines.withheld, amount: money(-(value.incomeTaxWithheldCents + value.vatWithheldCents)) },
    { key: "neto", label: text.lines.net, amount: money(value.netCents), total: true },
  ];
}

/** Sin factura: antes de liberar, en lo que no se paga y cuando faltan los datos fiscales (ahí va el aviso con «Capturar datos»). */
const NO_INVOICE: ReadonlySet<TeacherPayoutStatus> = new Set(["empty", "carried_forward", "tax_data_missing"]);

const LATEST = { in_review: text.latest.inReview, accepted: text.latest.accepted, rejected: text.latest.rejected } as const;

export function reportView(value: PayoutReportValue): ReportView {
  const { summary } = value;
  const released = value.money;
  const latest = value.invoice.latest;
  const carried = value.status === "carried_forward" && released !== null ? released.subtotalCents : null;
  const dueOn = value.invoiceDueOn === null ? null : longDay(value.invoiceDueOn);
  return {
    period: value.period,
    title: periodTitle(value.period),
    status: statusOf(value.status),
    step: PAYOUT_STATUS[value.status].step,
    steps: STEPS,
    next: nextStep({
      status: value.status,
      amount: released === null ? null : money(released.netCents),
      dueOn,
      submittedOn: latest?.status === "in_review" ? longDate(latest.submittedAt) : null,
      rejectionReason: latest?.status === "rejected" ? latest.rejectionReason : null,
      paidOn: value.payment === null ? null : longDay(value.payment.paidOn),
      reference: value.payment?.reference ?? null,
      carried: carried === null ? null : { amount: money(Math.abs(carried)), against: carried < 0 },
    }),
    overdue: value.overdue ? overdueText(dueOn) : null,
    summary: { pool: money(summary.poolCents), poolBps: percent(summary.poolBps), share: money(summary.totalCents), nothingAssigned: summary.nothingAssigned },
    money: released === null ? null : moneyLines(released),
    invoice:
      released === null || NO_INVOICE.has(value.status)
        ? null
        : {
            receiverRfc: value.invoice.receiverRfc,
            amounts: [
              { key: "subtotal", label: text.invoiceAmounts.subtotal, amount: money(released.subtotalCents) },
              { key: "iva", label: text.invoiceAmounts.vat, amount: money(released.vatCents) },
              { key: "isr", label: text.invoiceAmounts.incomeTax, amount: money(released.incomeTaxWithheldCents) },
              { key: "iva-retenido", label: text.invoiceAmounts.vatWithheld, amount: money(released.vatWithheldCents) },
              { key: "total", label: text.invoiceAmounts.total, amount: money(released.netCents) },
            ],
            latest:
              latest === null
                ? null
                : {
                    status: LATEST[latest.status],
                    submitted: t(text.submittedOn, { date: longDate(latest.submittedAt) }),
                    reviewed: latest.reviewedAt === null ? null : t(text.reviewedOn, { date: longDate(latest.reviewedAt) }),
                    reason: latest.status === "rejected" && latest.rejectionReason !== null ? t(text.rejectionReason, { reason: latest.rejectionReason }) : null,
                  },
          },
    payment: value.payment === null ? null : { paidOn: longDay(value.payment.paidOn), reference: value.payment.reference, amount: money(value.payment.amountCents) },
    students: value.students.map((student, index) => ({ key: `${index}:${student.alias}`, alias: student.alias, points: points(student.halfPoints) })),
    unconsumed: money(summary.unconsumedCents),
    totalPoints: points(summary.halfPoints),
    total: money(summary.totalCents),
  };
}

/** Un periodo en cero (`outcome: "empty"`): se muestra en cero, sin desglose ni factura. */
export function emptyReportView(read: { period: string; poolCents: number; poolBps: number; nothingAssigned: boolean }): ReportView {
  return {
    period: read.period,
    title: periodTitle(read.period),
    status: statusOf("empty"),
    step: null,
    steps: STEPS,
    next: nextStep({ status: "empty", amount: null, dueOn: null, submittedOn: null, rejectionReason: null, paidOn: null, reference: null, carried: null }),
    overdue: null,
    summary: { pool: money(read.poolCents), poolBps: percent(read.poolBps), share: money(0), nothingAssigned: read.nothingAssigned },
    money: null,
    invoice: null,
    payment: null,
    students: [],
    unconsumed: money(0),
    totalPoints: points(0),
    total: money(0),
  };
}
