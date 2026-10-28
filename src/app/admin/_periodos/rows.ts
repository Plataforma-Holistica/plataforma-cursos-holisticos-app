import { clockTime, longDate, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import { periodClosePath, periodPath, ROUTES } from "@/services/account/navigation";
import type { AlertKind, FinanceAlerts } from "@/services/anomalies/anomalies";
import type { FinanceClose, FinancePeriod, FinancePeriods, PeriodStatus, RunFigures, RunTeacher } from "@/services/periods/periods";

import { periodsButton } from "./outcomes";

// Lo que PA-78 a PA-80 pintan, ya en palabras y con los valores de sus botones (T-605). Lo arma la página
// con lo que leyó: el navegador no decide qué se ofrece, ni sabe leer fechas o centavos. El panel no
// calcula nada al abrirse: el bote, el porcentaje y el sin consumo salen del cierre o del último ensayo,
// con su fecha (decisión mía sin confirmar del 2026-10-27).

const text = admin.periods;

const MONEY = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const DECIMAL = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
const MONTH = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });

/** Centavos, como se leen: «$1,234.56». */
export const money = (cents: number): string => MONEY.format(cents / 100);
/** Puntos base, como porcentaje: «60 %», «62.5 %». */
export const percent = (bps: number): string => t(text.percent, { percent: DECIMAL.format(bps / 100) });
/** El periodo, como mes: «octubre de 2027». */
export const periodName = (period: number): string => MONTH.format(Date.UTC(Math.floor(period / 100), (period % 100) - 1, 1));

const dateAndTime = (iso: string) => ({ date: longDate(iso), time: clockTime(iso, PRODUCT_TIME_ZONE) });

export type StatusTone = "neutral" | "active" | "good";
const TONES: Record<PeriodStatus, StatusTone> = { open: "neutral", closing: "active", closed: "good", paid: "good" };
const ORDER: readonly PeriodStatus[] = ["open", "closing", "closed", "paid"];

/** Una cifra de PA-79 y PA-80: su nombre, su valor (nulo si no hay dato), su contexto y su etiqueta de parcial. */
export interface Tile {
  label: string;
  value: string | null;
  context?: string;
  tag?: string;
}

// ---------------------------------------------------------------------------------------
// PA-78.

export interface PeriodListRow {
  key: string;
  name: string;
  href: string;
  status: string;
  tone: StatusTone;
  /** El periodo en curso: va arriba, marcado. */
  current: boolean;
  students: string;
  pool: string;
  percent: string;
  /** De qué ensayo salen las cifras; nulo si son del cierre. */
  source: string | null;
  payouts: string;
}

export function periodsView(read: FinancePeriods, now: string): { rows: PeriodListRow[] } {
  const at = new Date(now).getTime();
  const rows = read.periods.map((row) => ({
    key: String(row.periodId),
    name: periodName(row.periodId),
    href: periodPath(row.periodId),
    status: text.statuses[row.status],
    tone: TONES[row.status],
    current: new Date(row.startsAt).getTime() <= at && at < new Date(row.endsAt).getTime(),
    students: row.activeStudents === null ? text.noFigure : String(row.activeStudents),
    pool: row.poolCents === null ? text.noFigure : money(row.poolCents),
    percent: row.poolBps === null ? text.noFigure : percent(row.poolBps),
    source: row.rehearsedAt === null ? null : t(text.fromRehearsal, { date: longDate(row.rehearsedAt) }),
    payouts: t(text.paidOfTotal, { paid: row.payouts.paid, total: row.payouts.total }),
  }));
  // El en curso arriba; los demás, en el orden de la base (el más reciente primero).
  return { rows: [...rows.filter((row) => row.current), ...rows.filter((row) => !row.current)] };
}

// ---------------------------------------------------------------------------------------
// PA-79.

export interface AlertRow {
  key: string;
  kind: string;
  teacher: string;
  status: string;
  tone: "attention" | "good";
  href: string;
}

export interface PeriodView {
  periodId: number;
  name: string;
  status: string;
  tone: StatusTone;
  steps: { label: string; current: boolean }[];
  /** El código de quien mira es reciente: se ofrece decidir. */
  canChange: boolean;
  /** Cerrado o pagado: todo en solo lectura. */
  readOnly: boolean;
  alertsWarning: string | null;
  collected: Tile;
  assigned: Tile;
  students: Tile;
  pool: Tile;
  poolPercent: Tile;
  unconsumed: Tile;
  /** De dónde salen el bote, el porcentaje y el sin consumo. */
  figuresSource: string;
  alerts: { kind: "rows"; rows: AlertRow[] } | { kind: "unavailable" };
  rollup: {
    last: string;
    /** La última corrida falló: el aviso y la última que terminó bien. */
    failed: [string, string] | null;
    /** El último pedido de recálculo, en palabras. */
    request: string | null;
    /** El valor del botón «Recalcular», o nulo si no se ofrece. */
    button: string | null;
  };
  closeHref: string;
}

const KINDS: Record<AlertKind, string> = {
  teacher_points_jump: t(admin.alerts.kinds.teacherPointsJump),
  impossible_completion: admin.alerts.kinds.impossibleCompletion,
  unconsumed_pool_ratio: admin.alerts.kinds.unconsumedPoolRatio,
};

const modeOf = (mode: string | null) => (mode === "full" ? text.rollupModes.full : mode === "dirty" ? text.rollupModes.dirty : text.rollupModes.other);

/** El sin consumo como parte del bote, en puntos base enteros. */
const shareOf = (part: number, whole: number) => Math.round((part * 10_000) / whole);

function figureTiles(source: RunFigures | null, tag: string | undefined) {
  const pool = source?.poolCents ?? null;
  const unconsumed = source?.unconsumedCents ?? null;
  return {
    students: { label: text.students, value: source?.activeStudents == null ? null : String(source.activeStudents), tag },
    pool: { label: text.pool, value: pool === null ? null : money(pool), tag },
    poolPercent: { label: text.poolPercent, value: source?.poolBps == null ? null : percent(source.poolBps), tag },
    unconsumed: {
      label: text.unconsumed,
      value: unconsumed === null ? null : money(unconsumed),
      context: unconsumed === null || pool === null || pool <= 0 ? undefined : t(text.unconsumedContext, { percent: percent(shareOf(unconsumed, pool)) }),
      tag,
    },
  };
}

export function periodView(read: Extract<FinancePeriod, { period: object }>, alerts: FinanceAlerts | null, now: string): PeriodView {
  const { period } = read;
  const open = period.status === "open";
  const closed = period.status === "closed" || period.status === "paid";
  const partialNow = open ? t(text.partialAt, { date: longDate(now) }) : undefined;

  // Las cifras del reparto: del cierre si ya cerró; si no, del último ensayo que salió bien.
  const source: RunFigures | null = read.close ?? read.rehearsal;
  const fromRehearsal = read.close === null ? read.rehearsal : null;
  const sourceTag = fromRehearsal !== null && fromRehearsal.statusAtRun === "open" ? t(text.partialRehearsal, { date: longDate(fromRehearsal.at) }) : undefined;
  const figuresSource =
    read.close !== null && period.closedAt !== null
      ? t(text.figuresFromClose, { date: longDate(period.closedAt) })
      : fromRehearsal !== null
        ? t(text.figuresFromRehearsal, { date: longDate(fromRehearsal.at) })
        : text.figuresNeedRehearsal;

  const { lastRollup, lastGoodRollup, rollupRequest } = read;
  const last = lastRollup === null ? text.rollupNever : t(text.rollupLast, { ...dateAndTime(lastRollup.startedAt), mode: modeOf(lastRollup.mode), result: text.rollupResults[lastRollup.status] });
  const failed: [string, string] | null =
    lastRollup?.status === "failed" ? [text.rollupFailed, lastGoodRollup === null ? text.rollupNoGood : t(text.rollupLastGood, dateAndTime(lastGoodRollup.startedAt))] : null;
  let request: string | null = null;
  if (rollupRequest !== null) {
    switch (rollupRequest.status) {
      case "pending":
        request = t(text.rollupRequested, dateAndTime(rollupRequest.requestedAt));
        break;
      case "running":
        request = t(text.rollupRunning, dateAndTime(rollupRequest.requestedAt));
        break;
      case "succeeded":
        request = t(text.rollupDone, dateAndTime(rollupRequest.finishedAt ?? rollupRequest.requestedAt));
        break;
      case "failed":
        request = text.rollupRequestFailed;
        break;
    }
  }
  const requestInFlight = rollupRequest?.status === "pending" || rollupRequest?.status === "running";

  return {
    periodId: period.periodId,
    name: periodName(period.periodId),
    status: text.statuses[period.status],
    tone: TONES[period.status],
    steps: ORDER.map((status) => ({ label: text.statuses[status], current: status === period.status })),
    canChange: read.freshCode,
    readOnly: closed,
    alertsWarning: read.openAlerts > 0 ? t(plural(read.openAlerts, text.alertsPending), { count: read.openAlerts }) : null,
    collected: {
      label: text.collected,
      value: money(read.collected.grossCents),
      context: t(text.collectedContext, { net: money(read.collected.netCents), count: read.collected.charges }),
      tag: partialNow,
    },
    assigned: {
      label: text.assigned,
      // Cerrado, lo que congeló el cierre: lo asignado de ahora podría ya no ser lo que se repartió.
      value: money(read.close?.netRevenueCents ?? read.assigned.baseCents),
      // El conteo de ahora no es el congelado: cerrado, no se dice.
      context: read.close?.netRevenueCents == null ? t(text.assignedContext, { count: read.assigned.students }) : text.assignedClosedContext,
      tag: partialNow,
    },
    ...figureTiles(source, sourceTag),
    figuresSource,
    alerts:
      alerts === null
        ? { kind: "unavailable" }
        : {
            kind: "rows",
            rows: alerts.alerts
              .filter((alert) => alert.period === period.periodId)
              .map((alert) => ({
                key: alert.id,
                kind: KINDS[alert.kind],
                teacher: alert.teacherName ?? text.nobody,
                status: alert.status === "open" ? admin.alerts.open : admin.alerts.reviewed,
                tone: alert.status === "open" ? "attention" : "good",
                href: ROUTES.alerts,
              })),
          },
    rollup: {
      last,
      failed,
      request,
      button: read.freshCode && !closed && !requestInFlight ? periodsButton.rollup(period.periodId) : null,
    },
    closeHref: periodClosePath(period.periodId),
  };
}

// ---------------------------------------------------------------------------------------
// PA-80.

export interface TeacherRow {
  key: string;
  name: string;
  assigned: string;
  unconsumed: string;
  total: string;
  /** Vacío sin bono. */
  bonus: string;
  remains: string;
}

/** El resultado de una corrida: el del ensayo o el del cierre. */
export interface RunResult {
  pool: Tile;
  poolPercent: Tile;
  unconsumed: Tile;
  sum: { value: string; ok: boolean; carried: string | null };
  /** No se asignó nada: el bote entero pasa al siguiente (RN-06). */
  nothingAssigned: boolean;
  teachers: TeacherRow[];
  totals: { assigned: string; unconsumed: string; total: string; bonus: string };
}

export interface Check {
  label: string;
  done: boolean;
  /** A dónde se resuelve, si falta. */
  href?: string;
}

export interface CloseView {
  periodId: number;
  name: string;
  status: string;
  tone: StatusTone;
  panelHref: string;
  canChange: boolean;
  lastRehearsal: string;
  /** El valor del botón «Ensayar», o nulo si no se ofrece. */
  rehearse: string | null;
  /** El último ensayo, si el periodo no ha cerrado. */
  rehearsal: (RunResult & { banner: string; failed: boolean }) | null;
  checks: Check[];
  close: { kind: "month_open" } | { kind: "waits" } | { kind: "ready"; button: string } | { kind: "closed" };
  /** El título del diálogo de cierre. */
  dialogTitle: string;
  closedLine: string | null;
  /** Lo que congeló el cierre. */
  result: RunResult | null;
  download: { kind: "none" } | { kind: "missing" } | { kind: "locked" } | { kind: "offered"; button: string };
}

function runResult(run: RunFigures & { carriedInCents?: number | null }, teachers: RunTeacher[]): RunResult {
  const total = teachers.reduce((sum, row) => sum + row.totalCents, 0);
  const bonus = teachers.reduce((sum, row) => sum + row.founderBonusCents, 0);
  const carried = run.carriedOutCents ?? 0;
  const tiles = figureTiles(run, undefined);
  return {
    pool: tiles.pool,
    poolPercent: { ...tiles.poolPercent, context: run.activeStudents === null ? undefined : t(text.tierContext, { count: run.activeStudents }) },
    unconsumed: { ...tiles.unconsumed, context: t(text.unconsumedShared) },
    sum: { value: money(total), ok: run.poolCents !== null && total === run.poolCents - carried, carried: carried > 0 ? t(text.carriedOut, { amount: money(carried) }) : null },
    nothingAssigned: run.assignedCents === 0,
    teachers: teachers.map((row) => ({
      key: row.teacherId,
      name: row.name ?? text.noName,
      assigned: money(row.assignedCents),
      unconsumed: money(row.unconsumedCents),
      total: money(row.totalCents),
      bonus: row.founderBonusCents === 0 ? "" : money(row.founderBonusCents),
      remains: row.belowMinimum === null ? text.unknownRemains : row.belowMinimum ? text.belowMinimum : text.toPay,
    })),
    totals: {
      assigned: money(teachers.reduce((sum, row) => sum + row.assignedCents, 0)),
      unconsumed: money(teachers.reduce((sum, row) => sum + row.unconsumedCents, 0)),
      total: money(total),
      bonus: money(bonus),
    },
  };
}

export function closeView(read: Extract<FinanceClose, { period: object }>): CloseView {
  const { period, checks, rehearsal } = read;
  const open = period.status === "open";
  const closed = period.status === "closed" || period.status === "paid";

  let lastRehearsal: string = text.noRehearsal;
  if (rehearsal !== null) {
    lastRehearsal =
      rehearsal.status === "failed"
        ? t(text.lastRehearsalFailed, dateAndTime(rehearsal.at))
        : t(text.lastRehearsal, { ...dateAndTime(rehearsal.at), kind: rehearsal.statusAtRun === "closing" ? text.kindFinal : text.kindPartial });
  }

  const rollupCheck: Check =
    checks.lastRollup === "succeeded"
      ? { label: text.checks.rollupOk, done: true }
      : { label: checks.lastRollup === "running" ? text.checks.rollupRunning : checks.lastRollup === "failed" ? text.checks.rollupFailed : text.checks.rollupNone, done: false };
  const list: Check[] = [
    open ? { label: text.checks.monthOpen, done: false } : { label: text.checks.monthEnded, done: true },
    rollupCheck,
    checks.rollupMarks ? { label: text.checks.marksPending, done: false } : { label: text.checks.marksClear, done: true },
    checks.openAlerts > 0
      ? { label: t(plural(checks.openAlerts, text.checks.alertsPending), { count: checks.openAlerts }), done: false, href: ROUTES.alerts }
      : { label: text.checks.alertsClear, done: true },
    // Cerrar usa el último ensayo con datos finales, pero la pantalla solo muestra el último: si ese falló
    // o es parcial, quien confirma no estaría viendo el reparto que congela (revisión de la 70).
    rehearsal?.status === "failed"
      ? { label: text.checks.rehearsalFailed, done: false }
      : checks.finalRehearsal && rehearsal?.statusAtRun === "closing"
        ? { label: text.checks.finalRehearsal, done: true }
        : { label: text.checks.finalRehearsalMissing, done: false },
  ];
  // La suma del último ensayo que salió bien, contra su bote: la misma regla que la base revisa al cerrar.
  if (rehearsal !== null && rehearsal.status === "succeeded") {
    const shown = runResult(rehearsal, rehearsal.teachers);
    list.push(shown.sum.ok ? { label: text.checks.sumOk, done: true } : { label: text.checks.sumOff, done: false });
  }

  let close: CloseView["close"];
  if (closed) close = { kind: "closed" };
  else if (open) close = { kind: "month_open" };
  else close = read.freshCode && list.every((check) => check.done) ? { kind: "ready", button: periodsButton.askClose(period.periodId) } : { kind: "waits" };

  const run = read.close;
  let closedLine: string | null = null;
  if (run !== null && run.at !== null) closedLine = run.closedBy === null ? t(text.closedAt, dateAndTime(run.at)) : t(text.closedBy, { ...dateAndTime(run.at), name: run.closedBy });

  let download: CloseView["download"] = { kind: "none" };
  if (run !== null) download = run.export === null ? { kind: "missing" } : read.freshCode ? { kind: "offered", button: periodsButton.download(run.runId) } : { kind: "locked" };

  return {
    periodId: period.periodId,
    name: periodName(period.periodId),
    status: text.statuses[period.status],
    tone: TONES[period.status],
    panelHref: periodPath(period.periodId),
    canChange: read.freshCode,
    lastRehearsal,
    rehearse: read.freshCode && !closed ? periodsButton.rehearse(period.periodId) : null,
    rehearsal:
      rehearsal === null || closed
        ? null
        : {
            ...runResult(rehearsal, rehearsal.teachers),
            failed: rehearsal.status === "failed",
            banner: rehearsal.status === "failed" ? text.rehearsalFailedBanner : rehearsal.statusAtRun === "closing" ? text.finalBanner : text.partialBanner,
          },
    checks: closed ? [] : list,
    close,
    dialogTitle: t(text.dialogTitle, { period: periodName(period.periodId) }),
    closedLine,
    result: run === null ? null : runResult(run, run.teachers),
    download,
  };
}

// ---------------------------------------------------------------------------------------
// Los avisos de lo que salió bien. Viajan en una cookie de 60 segundos que no dice de qué periodo son:
// cada pantalla los pinta solo si lo que tiene delante es lo que el aviso dice (revisión de la 70).

/** Un momento de hace menos de un minuto y medio (lo que dura el aviso, con holgura), o un poco después. */
function recent(iso: string, now: string): boolean {
  const ago = new Date(now).getTime() - new Date(iso).getTime();
  return ago >= -5_000 && ago <= 90_000;
}

/** Si PA-80 pinta ese aviso: «cerrado» solo con el periodo cerrado; «ensayado» solo con un ensayo de hace un momento. */
export function acceptedCloseNotice(notice: "period_rehearsed" | "period_closed" | null, read: Extract<FinanceClose, { period: object }>, now: string): boolean {
  if (notice === "period_closed") return read.close !== null && read.close.at !== null && recent(read.close.at, now);
  if (notice === "period_rehearsed") return read.rehearsal !== null && read.rehearsal.status === "succeeded" && recent(read.rehearsal.at, now);
  return false;
}

/**
 * Si PA-79 pinta «Recálculo pedido»: con un pedido de hace un momento, o con uno pendiente o corriendo
 * (pedirlo otra vez contesta «ya pedido», y lo que se quería sigue en marcha).
 */
export function acceptedRollupNotice(read: Extract<FinancePeriod, { period: object }>, now: string): boolean {
  const request = read.rollupRequest;
  if (request === null) return false;
  return request.status === "pending" || request.status === "running" || recent(request.requestedAt, now);
}
