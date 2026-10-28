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

// Lo que el servicio de los periodos le pregunta a la base (05 §8.6; T-605): las tres lecturas de
// finanzas, el pedido de recálculo, el ensayo, el cierre y la descarga de la exportación. Cada función
// recibe la transacción ya abierta como servidor; ninguna recibe quién actúa.

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
      pool_cents: cents.nullable(),
      assigned_cents: cents.nullable(),
      unconsumed_cents: cents.nullable(),
      carried_out_cents: cents.nullable(),
    })
    .nullable(),
  rehearsal: z.strictObject({ ...figures, at, period_status_at_run: status }).nullable(),
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
            poolCents: read.close.pool_cents,
            assignedCents: read.close.assigned_cents,
            unconsumedCents: read.close.unconsumed_cents,
            carriedOutCents: read.close.carried_out_cents,
          },
    rehearsal: read.rehearsal === null ? null : { ...figuresOf(read.rehearsal), at: read.rehearsal.at, statusAtRun: read.rehearsal.period_status_at_run },
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

/** Cierra (`private.close_period()`). La suma se comprueba al confirmar: un 23514 sale del `commit`. */
export async function askClose(tx: Tx, periodId: number): Promise<unknown> {
  const [row] = await tx.query(sql`select private.close_period(${periodId}::integer) ->> 'outcome' as outcome`, outcomeRow);
  return row?.outcome ?? null;
}

/** La exportación de un cierre (`private.close_export_download()`), que deja la descarga en la auditoría. */
export async function askDownload(tx: Tx, runId: string): Promise<unknown> {
  return readData(tx, sql`select private.close_export_download(${runId}::uuid) as data`);
}
