import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql, type SqlQuery } from "@/adapters/supabase/sql";

import { periodSegment, type MyPayouts, type PayoutCsvAnswer, type PayoutReportAnswer } from "./payout-report";

// Lo que el reporte del maestro le pregunta a la base, como el servidor y a nombre de la persona (T-604, cuarta solicitud). Las funciones de `t604_reporte`
// se nombran solo aquí. Cada respuesta se lee con una forma estricta: si la base trajera una clave de más (un identificador del alumno, sus pesos), falla.

const answerRow = z.object({ answer: z.unknown() }).strict();

async function ask(tx: Tx, query: SqlQuery): Promise<unknown> {
  const rows = await tx.query(query, answerRow);
  return rows[0]?.answer;
}

const money = z.number().int();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.number().int().min(200001).max(999912);
const status = z.enum([
  "empty", "calculated", "awaiting_invoice", "invoice_in_review", "invoice_rejected", "ready_to_pay", "paid", "carried_forward", "payment_returned",
  "in_review", "tax_data_missing", "tax_data_review",
]);

const row = z
  .object({
    period_id: period, status, pool_cents: money, bonuses_cents: money, adjustments_cents: money, balance_applied_cents: money,
    net_cents: money.nullable(), carried_cents: money.nullable(), invoice_due_on: day.nullable(), overdue: z.boolean(),
    action: z.literal("upload_invoice").nullable(),
  })
  .strict();

const mineAnswer = z.union([
  z.object({ outcome: z.literal("ok"), balance_cents: money.nullable(), periods: z.array(row) }).strict(),
  z.object({ outcome: z.literal("not_teacher") }).strict(),
]);

export async function askPayoutsMine(tx: Tx): Promise<{ outcome: "ok"; value: MyPayouts } | { outcome: "not_teacher" }> {
  const answer = mineAnswer.parse(await ask(tx, sql`select private.payouts_mine() as answer`));
  if (answer.outcome !== "ok") return answer;
  return {
    outcome: "ok",
    value: {
      balanceCents: answer.balance_cents,
      periods: answer.periods.map((r) => ({
        period: periodSegment(r.period_id), status: r.status, poolCents: r.pool_cents, bonusesCents: r.bonuses_cents, adjustmentsCents: r.adjustments_cents,
        balanceAppliedCents: r.balance_applied_cents, netCents: r.net_cents, carriedCents: r.carried_cents, invoiceDueOn: r.invoice_due_on,
        overdue: r.overdue, action: r.action,
      })),
    },
  };
}

const instant = z.string().min(1);
const reportAnswer = z.union([
  z
    .object({
      outcome: z.literal("ok"),
      period_id: period,
      status: status.exclude(["empty"]),
      released: z.boolean(),
      invoice_due_on: day.nullable(),
      overdue: z.boolean(),
      summary: z
        .object({
          pool_cents: money, pool_bps: z.number().int(), nothing_assigned: z.boolean(), assigned_cents: money, unconsumed_cents: money,
          total_cents: money, half_points: z.number().int(), students: z.number().int(),
        })
        .strict(),
      money: z
        .object({
          pool_cents: money, bonuses_cents: money, adjustments_cents: money, balance_applied_cents: money, subtotal_cents: money, vat_cents: money,
          income_tax_withheld_cents: money, vat_withheld_cents: money, net_cents: money,
          bonuses: z.array(z.object({ kind: z.enum(["founder", "open_course", "discretionary"]), amount_cents: money }).strict()),
          adjustments: z.array(z.object({ origin_period_id: period, amount_cents: money }).strict()),
        })
        .strict()
        .nullable(),
      invoice: z
        .object({
          receiver_rfc: z.string().nullable(),
          latest: z
            .object({
              status: z.enum(["in_review", "accepted", "rejected"]), submitted_at: instant, reviewed_at: instant.nullable(),
              rejection_reason: z.string().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
      payment: z.object({ paid_on: day, reference: z.string(), amount_cents: money }).strict().nullable(),
      students: z.array(z.object({ alias: z.string(), half_points: z.number().int() }).strict()),
    })
    .strict(),
  z.object({ outcome: z.literal("empty"), period_id: period, pool_cents: money, pool_bps: z.number().int(), nothing_assigned: z.boolean() }).strict(),
  z.object({ outcome: z.enum(["not_teacher", "not_found"]) }).strict(),
]);

export async function askPayoutReport(tx: Tx, periodId: number): Promise<PayoutReportAnswer> {
  const a = reportAnswer.parse(await ask(tx, sql`select private.payout_report_mine(${periodId}::integer::public.period_id) as answer`));
  if (a.outcome === "empty") {
    return { outcome: "empty", period: periodSegment(a.period_id), poolCents: a.pool_cents, poolBps: a.pool_bps, nothingAssigned: a.nothing_assigned };
  }
  if (a.outcome !== "ok") return a;
  const m = a.money;
  const latest = a.invoice.latest;
  return {
    outcome: "ok",
    value: {
      period: periodSegment(a.period_id),
      status: a.status,
      released: a.released,
      invoiceDueOn: a.invoice_due_on,
      overdue: a.overdue,
      summary: {
        poolCents: a.summary.pool_cents, poolBps: a.summary.pool_bps, nothingAssigned: a.summary.nothing_assigned, assignedCents: a.summary.assigned_cents,
        unconsumedCents: a.summary.unconsumed_cents, totalCents: a.summary.total_cents, halfPoints: a.summary.half_points, students: a.summary.students,
      },
      money:
        m === null
          ? null
          : {
              poolCents: m.pool_cents, bonusesCents: m.bonuses_cents, adjustmentsCents: m.adjustments_cents, balanceAppliedCents: m.balance_applied_cents,
              subtotalCents: m.subtotal_cents, vatCents: m.vat_cents, incomeTaxWithheldCents: m.income_tax_withheld_cents, vatWithheldCents: m.vat_withheld_cents,
              netCents: m.net_cents,
              bonuses: m.bonuses.map((b) => ({ kind: b.kind, amountCents: b.amount_cents })),
              adjustments: m.adjustments.map((j) => ({ originPeriod: periodSegment(j.origin_period_id), amountCents: j.amount_cents })),
            },
      invoice: {
        receiverRfc: a.invoice.receiver_rfc,
        latest:
          latest === null
            ? null
            : {
                status: latest.status, submittedAt: new Date(latest.submitted_at).toISOString(),
                reviewedAt: latest.reviewed_at === null ? null : new Date(latest.reviewed_at).toISOString(), rejectionReason: latest.rejection_reason,
              },
      },
      payment: a.payment === null ? null : { paidOn: a.payment.paid_on, reference: a.payment.reference, amountCents: a.payment.amount_cents },
      students: a.students.map((s) => ({ alias: s.alias, halfPoints: s.half_points })),
    },
  };
}

const csvAnswer = z.union([
  z.object({ outcome: z.literal("ok"), period_id: period, csv: z.string() }).strict(),
  z.object({ outcome: z.enum(["not_teacher", "not_found"]) }).strict(),
]);

export async function askPayoutReportCsv(tx: Tx, periodId: number): Promise<PayoutCsvAnswer> {
  const a = csvAnswer.parse(await ask(tx, sql`select private.payout_report_csv_mine(${periodId}::integer::public.period_id) as answer`));
  return a.outcome === "ok" ? { outcome: "ok", csv: a.csv } : a;
}
