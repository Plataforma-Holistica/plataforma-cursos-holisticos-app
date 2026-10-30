import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql, type SqlQuery } from "@/adapters/supabase/sql";

import {
  CLOSE_ANSWERS,
  DOWNLOAD_ANSWERS,
  PERIOD_STATUSES,
  REHEARSE_ANSWERS,
  ROLLUP_ANSWERS,
  ROLLUP_REQUEST_STATUSES,
  RUN_STATUSES,
  type CloseAnswer,
  type CloseExportFile,
  type DownloadAnswer,
  type FinanceClose,
  type FinancePeriod,
  type FinancePeriods,
  type RehearseAnswer,
  type RollupAnswer,
  type RunFigures,
  type RunTeacher,
} from "./panel";
import {
  BONUS_STATUSES,
  CONFIRM_ANSWERS,
  HOLD_ANSWERS,
  PAYOUT_STATUSES,
  RELEASE_ANSWERS,
  UNHOLD_ANSWERS,
  VOID_ANSWERS,
  type ConfirmDecided,
  type FinancePayouts,
  type HoldDecided,
  type Released,
  type UnholdDecided,
  type VoidAnswer,
} from "./payouts";

// Lo que el servicio de los periodos le pregunta a la base (05 §8.6; T-605): las tres lecturas de
// finanzas, el pedido de recálculo, el ensayo, el cierre y la descarga de la exportación; y, desde la
// cuarta solicitud, las liquidaciones de PA-81 (leerlas, liberar, retener, soltar y el bono del fundador).
// Cada función recibe la transacción ya abierta como servidor; ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);
// Centavos y conteos: enteros. La base los da de `bigint` y `numeric` como números de JSON.
const cents = z.number().int();
const count = z.number().int().min(0);
const at = z.string();
const period = z.number().int();
const status = z.enum(PERIOD_STATUSES);

// Estrictos: un campo que este código no conoce no pasa. Así un identificador de un alumno que alguien
// agregue a una función de la base no llega a la pantalla sin que esto cambie a la vista.
const figures = {
  run_id: id,
  active_students: count.nullable(),
  pool_bps: count.nullable(),
  net_revenue_cents: cents.nullable(),
  pool_cents: cents.nullable(),
  assigned_cents: cents.nullable(),
  unconsumed_cents: cents.nullable(),
  carried_out_cents: cents.nullable(),
};
const teacher = z.strictObject({
  teacher_id: id,
  name: z.string().nullable(),
  assigned_cents: cents,
  unconsumed_cents: cents,
  total_cents: cents,
  founder_bonus_cents: cents,
  estimate_cents: cents,
  below_minimum: z.boolean().nullable(),
});

const periodsSchema = z.strictObject({
  fresh_code: z.boolean(),
  periods: z.array(
    z.strictObject({
      period_id: period,
      status,
      starts_at: at,
      ends_at: at,
      active_students: count.nullable(),
      pool_bps: count.nullable(),
      pool_cents: cents.nullable(),
      unconsumed_cents: cents.nullable(),
      rehearsed_at: at.nullable(),
      payouts: z.strictObject({ total: count, paid: count }),
    }),
  ),
});

const missing = z.strictObject({ fresh_code: z.boolean(), period: z.null() });

const periodSchema = z.strictObject({
  fresh_code: z.boolean(),
  period: z.strictObject({
    period_id: period,
    status,
    starts_at: at,
    ends_at: at,
    entered_closing_at: at.nullable(),
    active_students: count.nullable(),
    pool_bps: count.nullable(),
    carried_in_cents: cents,
    closed_at: at.nullable(),
    payouts_released_at: at.nullable(),
    paid_at: at.nullable(),
  }),
  collected: z.strictObject({ charges: count, gross_mxn_cents: cents, revenue_net_mxn_cents: cents }),
  assigned: z.strictObject({ students: count, base_cents: cents }),
  close: z
    .strictObject({
      run_id: id,
      net_revenue_cents: cents.nullable(),
      student_pools_cents: cents.nullable(),
      pool_cents: cents.nullable(),
      assigned_cents: cents.nullable(),
      unconsumed_cents: cents.nullable(),
      carried_out_cents: cents.nullable(),
    })
    .nullable(),
  rehearsal: z.strictObject({ ...figures, student_pools_cents: cents.nullable(), at, period_status_at_run: status }).nullable(),
  unconsumed_alert_bps: z.number().int().min(1).max(10_000).nullable(),
  unconsumed_over: z.boolean().nullable(),
  open_alerts: count,
  last_rollup: z.strictObject({ status: z.enum(RUN_STATUSES), mode: z.string().nullable(), started_at: at, finished_at: at.nullable() }).nullable(),
  last_good_rollup: z.strictObject({ mode: z.string().nullable(), started_at: at, finished_at: at.nullable() }).nullable(),
  rollup_request: z
    .strictObject({ status: z.enum(ROLLUP_REQUEST_STATUSES), requested_at: at, started_at: at.nullable(), finished_at: at.nullable() })
    .nullable(),
});

const closeSchema = z.strictObject({
  fresh_code: z.boolean(),
  period: z.strictObject({ period_id: period, status, ends_at: at, entered_closing_at: at.nullable() }),
  checks: z.strictObject({ open_alerts: count, final_rehearsal: z.boolean(), last_rollup: z.enum(RUN_STATUSES).nullable(), rollup_marks: z.boolean() }),
  rehearsal: z
    .strictObject({
      ...figures,
      at,
      status: z.enum(RUN_STATUSES),
      period_status_at_run: status,
      carried_in_cents: cents.nullable(),
      teachers: z.array(teacher),
    })
    .nullable(),
  close: z
    .strictObject({
      ...figures,
      at: at.nullable(),
      closed_by: z.string().nullable(),
      export: z.strictObject({ rows: count, sha256: z.string().regex(/^[0-9a-f]{64}$/), created_at: at }).nullable(),
      teachers: z.array(teacher),
    })
    .nullable(),
});

const downloadSchema = z.union([
  z.strictObject({
    outcome: z.literal("ok"),
    period_id: period,
    // El nombre lo arma la base con el periodo: nunca una ruta.
    filename: z.string().regex(/^cierre-\d{4}-\d{2}\.csv$/),
    rows: count,
    format_version: z.literal(1),
    content: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({ outcome: z.enum(DOWNLOAD_ANSWERS) }),
]);

type Figures = z.infer<z.ZodObject<typeof figures>>;
const figuresOf = (run: Figures): RunFigures => ({
  runId: run.run_id,
  activeStudents: run.active_students,
  poolBps: run.pool_bps,
  netRevenueCents: run.net_revenue_cents,
  poolCents: run.pool_cents,
  assignedCents: run.assigned_cents,
  unconsumedCents: run.unconsumed_cents,
  carriedOutCents: run.carried_out_cents,
});
const teacherOf = (row: z.infer<typeof teacher>): RunTeacher => ({
  teacherId: row.teacher_id,
  name: row.name,
  assignedCents: row.assigned_cents,
  unconsumedCents: row.unconsumed_cents,
  totalCents: row.total_cents,
  founderBonusCents: row.founder_bonus_cents,
  estimateCents: row.estimate_cents,
  belowMinimum: row.below_minimum,
});

/** Lo que contestó `private.finance_periods()`, o nulo si contestó nulo. Otra forma lanza. */
export function periodsReadOf(raw: unknown): FinancePeriods | null {
  if (raw === null) return null;
  const read = periodsSchema.parse(raw);
  return {
    freshCode: read.fresh_code,
    periods: read.periods.map((row) => ({
      periodId: row.period_id,
      status: row.status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      activeStudents: row.active_students,
      poolBps: row.pool_bps,
      poolCents: row.pool_cents,
      unconsumedCents: row.unconsumed_cents,
      rehearsedAt: row.rehearsed_at,
      payouts: { total: row.payouts.total, paid: row.payouts.paid },
    })),
  };
}

/** Lo que contestó `private.finance_period()`, o nulo si contestó nulo. Otra forma lanza. */
export function periodReadOf(raw: unknown): FinancePeriod | null {
  if (raw === null) return null;
  const none = missing.safeParse(raw);
  if (none.success) return { freshCode: none.data.fresh_code, period: null };
  const read = periodSchema.parse(raw);
  const p = read.period;
  return {
    freshCode: read.fresh_code,
    period: {
      periodId: p.period_id,
      status: p.status,
      startsAt: p.starts_at,
      endsAt: p.ends_at,
      enteredClosingAt: p.entered_closing_at,
      activeStudents: p.active_students,
      poolBps: p.pool_bps,
      carriedInCents: p.carried_in_cents,
      closedAt: p.closed_at,
      payoutsReleasedAt: p.payouts_released_at,
      paidAt: p.paid_at,
    },
    collected: { charges: read.collected.charges, grossCents: read.collected.gross_mxn_cents, netCents: read.collected.revenue_net_mxn_cents },
    assigned: { students: read.assigned.students, baseCents: read.assigned.base_cents },
    close:
      read.close === null
        ? null
        : {
            runId: read.close.run_id,
            // El cierre de un periodo cerrado no repite estas dos: son las del periodo.
            activeStudents: p.active_students,
            poolBps: p.pool_bps,
            netRevenueCents: read.close.net_revenue_cents,
            studentPoolsCents: read.close.student_pools_cents,
            poolCents: read.close.pool_cents,
            assignedCents: read.close.assigned_cents,
            unconsumedCents: read.close.unconsumed_cents,
            carriedOutCents: read.close.carried_out_cents,
          },
    rehearsal:
      read.rehearsal === null
        ? null
        : {
            ...figuresOf(read.rehearsal),
            studentPoolsCents: read.rehearsal.student_pools_cents,
            at: read.rehearsal.at,
            statusAtRun: read.rehearsal.period_status_at_run,
          },
    unconsumedAlertBps: read.unconsumed_alert_bps,
    unconsumedOver: read.unconsumed_over,
    openAlerts: read.open_alerts,
    lastRollup:
      read.last_rollup === null
        ? null
        : { status: read.last_rollup.status, mode: read.last_rollup.mode, startedAt: read.last_rollup.started_at, finishedAt: read.last_rollup.finished_at },
    lastGoodRollup:
      read.last_good_rollup === null
        ? null
        : { mode: read.last_good_rollup.mode, startedAt: read.last_good_rollup.started_at, finishedAt: read.last_good_rollup.finished_at },
    rollupRequest:
      read.rollup_request === null
        ? null
        : {
            status: read.rollup_request.status,
            requestedAt: read.rollup_request.requested_at,
            startedAt: read.rollup_request.started_at,
            finishedAt: read.rollup_request.finished_at,
          },
  };
}

/** Lo que contestó `private.finance_close()`, o nulo si contestó nulo. Otra forma lanza. */
export function closeReadOf(raw: unknown): FinanceClose | null {
  if (raw === null) return null;
  const none = missing.safeParse(raw);
  if (none.success) return { freshCode: none.data.fresh_code, period: null };
  const read = closeSchema.parse(raw);
  const { rehearsal, close } = read;
  return {
    freshCode: read.fresh_code,
    period: { periodId: read.period.period_id, status: read.period.status, endsAt: read.period.ends_at, enteredClosingAt: read.period.entered_closing_at },
    checks: {
      openAlerts: read.checks.open_alerts,
      finalRehearsal: read.checks.final_rehearsal,
      lastRollup: read.checks.last_rollup,
      rollupMarks: read.checks.rollup_marks,
    },
    rehearsal:
      rehearsal === null
        ? null
        : {
            ...figuresOf(rehearsal),
            at: rehearsal.at,
            status: rehearsal.status,
            statusAtRun: rehearsal.period_status_at_run,
            carriedInCents: rehearsal.carried_in_cents,
            teachers: rehearsal.teachers.map(teacherOf),
          },
    close:
      close === null
        ? null
        : {
            ...figuresOf(close),
            at: close.at,
            closedBy: close.closed_by,
            export: close.export === null ? null : { rows: close.export.rows, sha256: close.export.sha256, createdAt: close.export.created_at },
            teachers: close.teachers.map(teacherOf),
          },
  };
}

/** Lo que contestó la descarga: el archivo, o una respuesta de su lista. Otra forma lanza. */
export function downloadOf(raw: unknown): ({ outcome: "ok" } & CloseExportFile) | { outcome: DownloadAnswer } {
  const read = downloadSchema.parse(raw);
  if (read.outcome !== "ok") return { outcome: read.outcome };
  return { outcome: "ok", filename: read.filename, rows: read.rows, content: read.content, sha256: read.sha256 };
}

/** La respuesta de una decisión, si está en su lista. Otra lanza: no se pinta como hecha. */
function answerIn<Answer extends string>(list: readonly Answer[], raw: unknown): Answer {
  const found = list.find((each) => each === raw);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}
export const rollupAnswerOf = (raw: unknown): RollupAnswer => answerIn(ROLLUP_ANSWERS, raw);
export const rehearseAnswerOf = (raw: unknown): RehearseAnswer => answerIn(REHEARSE_ANSWERS, raw);
export const closeAnswerOf = (raw: unknown): CloseAnswer => answerIn(CLOSE_ANSWERS, raw);

const dataRow = z.object({ data: z.unknown() });
const outcomeRow = z.object({ outcome: z.string().nullable() });
const recentRow = z.object({ recent: z.boolean().nullable() });

async function readData(tx: Tx, query: SqlQuery): Promise<unknown> {
  const [row] = await tx.query(query, dataRow);
  if (!row) throw new Error("La base no contestó la lectura.");
  return row.data;
}

export async function readPeriods(tx: Tx): Promise<FinancePeriods | null> {
  return periodsReadOf(await readData(tx, sql`select private.finance_periods() as data`));
}

export async function readPeriod(tx: Tx, periodId: number): Promise<FinancePeriod | null> {
  return periodReadOf(await readData(tx, sql`select private.finance_period(${periodId}::integer) as data`));
}

export async function readClose(tx: Tx, periodId: number): Promise<FinanceClose | null> {
  return closeReadOf(await readData(tx, sql`select private.finance_close(${periodId}::integer) as data`));
}

/** Pide el recálculo (`private.request_rollup()`). Devuelve lo que contestó, sin juzgarlo. */
export async function askRollup(tx: Tx, periodId: number): Promise<unknown> {
  const [row] = await tx.query(sql`select private.request_rollup(${periodId}::integer) ->> 'outcome' as outcome`, outcomeRow);
  return row?.outcome ?? null;
}

/**
 * Ensaya (`private.rehearse_close()`), salvo que haya un ensayo de ese periodo, bien o fallido, de hace
 * menos de un minuto: entonces contesta `too_soon` sin ensayar. Cada ensayo es un renglón que no se borra
 * (decisión mía sin confirmar del 2026-10-27). La puerta va primero: sin el código reciente no se dice
 * «espera», se ensaya y la base pide el código (revisión de la 70). La revisión no toma candado: dos
 * envíos a la vez pueden ensayar los dos, y no pasa nada.
 */
export async function askRehearsal(tx: Tx, periodId: number): Promise<unknown> {
  const [recent] = await tx.query(
    sql`select (r ->> 'fresh_code')::boolean and (r #>> '{rehearsal,at}')::timestamptz > now() - interval '1 minute' as recent
        from private.finance_close(${periodId}::integer) as r`,
    recentRow,
  );
  if (recent?.recent === true) return "too_soon";
  const [row] = await tx.query(sql`select private.rehearse_close(${periodId}::integer) ->> 'outcome' as outcome`, outcomeRow);
  return row?.outcome ?? null;
}

/**
 * Cierra (`private.close_period()`) con el ensayo que se tenía a la vista. La suma se comprueba al confirmar: un
 * 23514 sale del `commit`.
 */
export async function askClose(tx: Tx, periodId: number, runId: string): Promise<unknown> {
  const [row] = await tx.query(sql`select private.close_period(${periodId}::integer, ${runId}::uuid) ->> 'outcome' as outcome`, outcomeRow);
  return row?.outcome ?? null;
}

/** La exportación de un cierre (`private.close_export_download()`), que deja la descarga en la auditoría. */
export async function askDownload(tx: Tx, runId: string): Promise<unknown> {
  return readData(tx, sql`select private.close_export_download(${runId}::uuid) as data`);
}

// ---------------------------------------------------------------------------------------
// Las liquidaciones del periodo (PA-81; T-605, cuarta solicitud).

const payoutStatus = z.enum(PAYOUT_STATUSES);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const payoutRow = z.strictObject({
  teacher_id: id,
  name: z.string().nullable(),
  payout_id: id.nullable(),
  status: payoutStatus.nullable(),
  held_from_status: payoutStatus.nullable(),
  hold_reason: z.string().nullable(),
  held_at: at.nullable(),
  released_at: at.nullable(),
  pool_cents: cents,
  founder_bonus: z
    .strictObject({ bonus_id: id, status: z.enum(BONUS_STATUSES), amount_cents: cents, basis_cents: cents.nullable() })
    .nullable(),
  manual_bonuses_cents: cents,
  adjustments_cents: cents,
  balance_cents: cents,
  subtotal_cents: cents,
  estimated: z.boolean(),
  reaches_minimum: z.boolean().nullable(),
  unhold_fingerprint: fingerprint.nullable(),
  is_self: z.boolean(),
});
const payoutsSchema = z.strictObject({
  fresh_code: z.boolean(),
  period: z.strictObject({
    period_id: period,
    status,
    closed_at: at.nullable(),
    payouts_released_at: at.nullable(),
    paid_at: at.nullable(),
    minimum_cents: cents.nullable(),
    changed_at: at.nullable(),
  }),
  release: z.strictObject({ fingerprint, pending_founder_bonuses: count }).nullable(),
  payouts: z.array(payoutRow),
});

/** La lectura de PA-81. Nula: quien actúa no tiene finanzas. Otra forma lanza. */
export function payoutsReadOf(raw: unknown): FinancePayouts | null {
  if (raw === null) return null;
  const none = missing.safeParse(raw);
  if (none.success) return { freshCode: none.data.fresh_code, period: null };
  const read = payoutsSchema.parse(raw);
  const p = read.period;
  return {
    freshCode: read.fresh_code,
    period: {
      periodId: p.period_id,
      status: p.status,
      closedAt: p.closed_at,
      payoutsReleasedAt: p.payouts_released_at,
      paidAt: p.paid_at,
      minimumCents: p.minimum_cents,
      changedAt: p.changed_at,
    },
    release: read.release === null ? null : { fingerprint: read.release.fingerprint, pendingFounderBonuses: read.release.pending_founder_bonuses },
    payouts: read.payouts.map((row) => ({
      teacherId: row.teacher_id,
      name: row.name,
      payoutId: row.payout_id,
      status: row.status,
      heldFromStatus: row.held_from_status,
      holdReason: row.hold_reason,
      heldAt: row.held_at,
      releasedAt: row.released_at,
      poolCents: row.pool_cents,
      founderBonus:
        row.founder_bonus === null
          ? null
          : {
              bonusId: row.founder_bonus.bonus_id,
              status: row.founder_bonus.status,
              amountCents: row.founder_bonus.amount_cents,
              basisCents: row.founder_bonus.basis_cents,
            },
      manualBonusesCents: row.manual_bonuses_cents,
      adjustmentsCents: row.adjustments_cents,
      balanceCents: row.balance_cents,
      subtotalCents: row.subtotal_cents,
      estimated: row.estimated,
      reachesMinimum: row.reaches_minimum,
      unholdFingerprint: row.unhold_fingerprint,
      isSelf: row.is_self,
    })),
  };
}

const answered = z.looseObject({ outcome: z.string() });
const releasedSchema = z.looseObject({ period: z.number().int().optional(), period_status: status.optional() });
const heldSchema = z.looseObject({ status: payoutStatus.optional() });
const unheldSchema = z.looseObject({ to: payoutStatus.optional() });
const decidedSchema = z.looseObject({ status: z.enum(BONUS_STATUSES).optional() });

/** Lo que contestó liberar. Una respuesta fuera de su lista lanza. */
export function releasedOf(raw: unknown): Released {
  const answer = answerIn(RELEASE_ANSWERS, answered.parse(raw).outcome);
  const extra = releasedSchema.parse(raw);
  return {
    answer,
    blockingPeriod: answer === "previous_not_released" ? (extra.period ?? null) : null,
    periodStatus: answer === "released" ? (extra.period_status ?? null) : null,
  };
}
export function heldOf(raw: unknown): HoldDecided {
  const answer = answerIn(HOLD_ANSWERS, answered.parse(raw).outcome);
  return { answer, status: answer === "changed" || answer === "not_holdable" ? (heldSchema.parse(raw).status ?? null) : null };
}
export function unheldOf(raw: unknown): UnholdDecided {
  const answer = answerIn(UNHOLD_ANSWERS, answered.parse(raw).outcome);
  return { answer, to: answer === "released_from_hold" ? (unheldSchema.parse(raw).to ?? null) : null };
}
export function confirmedOf(raw: unknown): ConfirmDecided {
  const answer = answerIn(CONFIRM_ANSWERS, answered.parse(raw).outcome);
  return { answer, status: answer === "already_decided" ? (decidedSchema.parse(raw).status ?? null) : null };
}
export const voidedOf = (raw: unknown): VoidAnswer => answerIn(VOID_ANSWERS, answered.parse(raw).outcome);

export async function readPayouts(tx: Tx, periodId: number): Promise<FinancePayouts | null> {
  return payoutsReadOf(await readData(tx, sql`select private.finance_payouts(${periodId}::integer) as data`));
}

/** Libera (`private.release_payouts()`) con la huella de lo que se vio. Lo liberado se comprueba al confirmar: un 23514 sale del `commit`. */
export async function askRelease(tx: Tx, periodId: number, seen: string): Promise<unknown> {
  return readData(tx, sql`select private.release_payouts(${periodId}::integer, ${seen}::text) as data`);
}

/** Retiene (`private.hold_payout()`) con el estado que se vio. Sin alerta: PA-81 no la enlaza todavía. */
export async function askHold(tx: Tx, payoutId: string, reason: string, seen: string): Promise<unknown> {
  return readData(tx, sql`select private.hold_payout(${payoutId}::uuid, ${reason}::text, ${seen}::text) as data`);
}

/** Suelta (`private.unhold_payout()`) con la huella de lo que se vio; si se libera ahí mismo, se comprueba al confirmar. */
export async function askUnhold(tx: Tx, payoutId: string, note: string | null, seen: string): Promise<unknown> {
  return readData(tx, sql`select private.unhold_payout(${payoutId}::uuid, ${note}::text, ${seen}::text) as data`);
}

export async function askConfirmFounder(tx: Tx, bonusId: string): Promise<unknown> {
  return readData(tx, sql`select private.confirm_founder_bonus(${bonusId}::uuid) as data`);
}

/**
 * Anula el bono (`private.void_bonus()`) solo si es el del fundador de ese periodo, leído en la misma
 * transacción: `void_bonus` anula cualquiera, y capturar y anular los demás es de PA-83. El tipo de un bono no
 * cambia, así que leerlo antes basta. Sin finanzas la lectura es nula, y no se anula nada.
 */
export async function askVoidFounder(tx: Tx, periodId: number, bonusId: string, reason: string): Promise<unknown> {
  const read = await readPayouts(tx, periodId);
  if (read === null) return { outcome: "forbidden" };
  if (read.period === null || !read.payouts.some((row) => row.founderBonus?.bonusId === bonusId)) return { outcome: "not_found" };
  return readData(tx, sql`select private.void_bonus(${bonusId}::uuid, ${reason}::text) as data`);
}
