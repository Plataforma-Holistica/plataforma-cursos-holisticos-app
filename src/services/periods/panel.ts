import "server-only";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { holds, type CodeGiven, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

// El panel del periodo, el ensayo y el cierre desde la aplicación (RF-501 a RF-503, RF-509, RF-705,
// RF-408; PA-78 a PA-80, FL-50; T-605). Quién puede lo decide la base, con la puerta de finanzas
// (`private.finance_change_gate()`: la capacidad y un código reciente); aquí se decide a quién se le
// pregunta qué y en qué orden, como en el servicio de las alertas:
//
//   · La guarda va primero: `teamStanding`, y solo sigue quien es del equipo con finanzas. Los demás
//     reciben `refused`, sin preguntarle nada más a la base. Si no se supo quién pide, `unavailable`.
//   · Lo que llega se revisa antes de tocar la base: un periodo con forma (`AAAAMM`, mes de 1 a 12) y
//     una corrida con forma de identificador. Lo que no la tiene no llega (`malformed`).
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra su lista cerrada. Otra
//     cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho. Dos excepciones se
//     dicen por su nombre: el tiempo vencido (57014) del ensayo o del cierre, y la suma que no cuadra al
//     confirmar el cierre (23514). El almacén las traduce a `CloseFailure`.
//   · Ensayar y cerrar corren mientras la pantalla espera, en una transacción del servidor con el tope de
//     tiempo de siempre (decisión mía sin confirmar del 2026-10-27; `05` §14.4 dice que caben).

export const PERIOD_STATUSES = ["open", "closing", "closed", "paid"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ROLLUP_REQUEST_STATUSES = ["pending", "running", "succeeded", "failed"] as const;
export type RollupRequestStatus = (typeof ROLLUP_REQUEST_STATUSES)[number];

/** Un periodo de la lista de PA-78. Las cifras de uno abierto o en cierre son las del último ensayo. */
export interface PeriodRow {
  periodId: number;
  status: PeriodStatus;
  startsAt: string;
  endsAt: string;
  activeStudents: number | null;
  poolBps: number | null;
  poolCents: number | null;
  unconsumedCents: number | null;
  /** De qué ensayo salen las cifras; nulo si son del cierre o no hay ensayo. */
  rehearsedAt: string | null;
  payouts: { total: number; paid: number };
}

export interface FinancePeriods {
  /** Las decisiones pasarían hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  /** El más reciente primero. */
  periods: PeriodRow[];
}

/** Las cifras de una corrida: el cierre, o un ensayo que salió bien. */
export interface RunFigures {
  runId: string;
  activeStudents: number | null;
  poolBps: number | null;
  netRevenueCents: number | null;
  /** El bote del mes, sin lo que pasó del anterior (para el porcentaje sin consumo, como la alerta). Nulo si no se leyó. */
  studentPoolsCents?: number | null;
  poolCents: number | null;
  assignedCents: number | null;
  unconsumedCents: number | null;
  carriedOutCents: number | null;
}

export interface RollupRun {
  status: RunStatus;
  mode: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** PA-79. `period` nulo: la base no tiene ese periodo. */
export type FinancePeriod =
  | { freshCode: boolean; period: null }
  | {
      freshCode: boolean;
      period: {
        periodId: number;
        status: PeriodStatus;
        startsAt: string;
        endsAt: string;
        enteredClosingAt: string | null;
        activeStudents: number | null;
        poolBps: number | null;
        carriedInCents: number;
        closedAt: string | null;
        payoutsReleasedAt: string | null;
        paidAt: string | null;
      };
      /** Lo cobrado en el periodo: los cobros que caen en él. */
      collected: { charges: number; grossCents: number; netCents: number };
      /** Lo asignado al periodo: lo que reparte el cierre, con la parte de los anuales cobrados antes. */
      assigned: { students: number; baseCents: number };
      close: RunFigures | null;
      rehearsal: (RunFigures & { at: string; statusAtRun: PeriodStatus }) | null;
      openAlerts: number;
      /** El umbral de `ALERTA_SIN_CONSUMO_PCT` (puntos base), el vigente al cerrar si ya cerró; nulo si no es válido. */
      unconsumedAlertBps: number | null;
      /** Si el bote sin consumo lo pasa, con datos finales (decisiones de Sergio del 2026-10-27); nulo sin datos finales. */
      unconsumedOver: boolean | null;
      lastRollup: RollupRun | null;
      lastGoodRollup: Omit<RollupRun, "status"> | null;
      rollupRequest: { status: RollupRequestStatus; requestedAt: string; startedAt: string | null; finishedAt: string | null } | null;
    };

/** Un maestro de una corrida, con su nombre publicado como estaba. */
export interface RunTeacher {
  teacherId: string;
  name: string | null;
  assignedCents: number;
  unconsumedCents: number;
  totalCents: number;
  founderBonusCents: number;
  estimateCents: number;
  /** Debajo del pago mínimo; nulo si no se sabe (un ensayo sin vista previa del pago). */
  belowMinimum: boolean | null;
}

/** PA-80. `period` nulo: la base no tiene ese periodo. */
export type FinanceClose =
  | { freshCode: boolean; period: null }
  | {
      freshCode: boolean;
      period: { periodId: number; status: PeriodStatus; endsAt: string; enteredClosingAt: string | null };
      /** Lo que se sabe sin calcular de lo que falta para cerrar. Lo que manda es la respuesta del cierre. */
      checks: { openAlerts: number; finalRehearsal: boolean; lastRollup: RunStatus | null; rollupMarks: boolean };
      /** El último ensayo, bien o fallido (sin el texto del error). */
      rehearsal:
        | (Omit<RunFigures, "runId"> & {
            runId: string;
            at: string;
            status: RunStatus;
            statusAtRun: PeriodStatus;
            carriedInCents: number | null;
            teachers: RunTeacher[];
          })
        | null;
      close:
        | (RunFigures & {
            at: string | null;
            closedBy: string | null;
            export: { rows: number; sha256: string; createdAt: string } | null;
            teachers: RunTeacher[];
          })
        | null;
    };

/** Lo que contesta `private.request_rollup()`. */
export const ROLLUP_ANSWERS = ["requested", "already_requested", "not_rollable", "malformed", "forbidden", "needs_fresh_code"] as const;
export type RollupAnswer = (typeof ROLLUP_ANSWERS)[number];
/** Lo que contesta `private.rehearse_close()`, más `too_soon`: un ensayo de ese periodo hace menos de un minuto (el almacén). */
export const REHEARSE_ANSWERS = [
  "rehearsed",
  "failed",
  "already_closed",
  "no_period",
  "photo_missing",
  "no_pool_bps",
  "before_launch",
  "malformed",
  "forbidden",
  "needs_fresh_code",
  "too_soon",
] as const;
export type RehearseAnswer = (typeof REHEARSE_ANSWERS)[number];
/** Lo que contesta `private.close_period()` (05 §8.6). */
export const CLOSE_ANSWERS = [
  "closed",
  "already_closed",
  "not_closing",
  "before_launch",
  "previous_not_closed",
  "photo_missing",
  "no_pool_bps",
  "rollup_running",
  "last_rollup_failed",
  "needs_full_rollup",
  "rollup_marks",
  "open_alerts",
  "rehearsal_missing",
  "rehearsal_stale",
  // El ensayo que se tenía a la vista ya no es el último: alguien ensayó después (T-605, tercera solicitud).
  "rehearsal_superseded",
  "malformed",
  "forbidden",
  "needs_fresh_code",
] as const;
export type CloseAnswer = (typeof CLOSE_ANSWERS)[number];
/** Lo que contesta `private.close_export_download()` cuando no da el archivo. */
export const DOWNLOAD_ANSWERS = ["not_found", "forbidden", "needs_fresh_code"] as const;
export type DownloadAnswer = (typeof DOWNLOAD_ANSWERS)[number];

/** La exportación de un cierre (RF-509), tal como la guardó la base. */
export interface CloseExportFile {
  filename: string;
  content: string;
  rows: number;
  sha256: string;
}

/** Lo que el almacén lanza cuando el ensayo o el cierre no terminaron por una razón con nombre. */
export class CloseFailure extends Error {
  readonly reason: "timed_out" | "unbalanced";

  constructor(reason: "timed_out" | "unbalanced") {
    super(reason === "timed_out" ? "El ensayo o el cierre pasó del tope de tiempo." : "La suma del cierre no cuadró al confirmar.");
    this.name = "CloseFailure";
    this.reason = reason;
  }
}

/**
 * Lo que este servicio le pregunta a la base, a nombre de las claims que se le pasan. Las lecturas son
 * nulas cuando quien actúa no pasa la puerta del equipo con finanzas. Las decisiones lanzan si la base
 * no contestó algo de su lista: quien llama lo trata como «no se supo».
 */
export interface PeriodStore {
  periods(claims: VerifiedClaims): Promise<FinancePeriods | null>;
  period(claims: VerifiedClaims, period: number): Promise<FinancePeriod | null>;
  close(claims: VerifiedClaims, period: number): Promise<FinanceClose | null>;
  requestRollup(claims: VerifiedClaims, period: number): Promise<RollupAnswer>;
  rehearse(claims: VerifiedClaims, period: number): Promise<RehearseAnswer>;
  /** Cierra con el ensayo que se tenía a la vista: la base solo cierra si es el último y de los datos de ahora. */
  closePeriod(claims: VerifiedClaims, period: number, run: string): Promise<CloseAnswer>;
  download(claims: VerifiedClaims, run: string): Promise<({ outcome: "ok" } & CloseExportFile) | { outcome: DownloadAnswer }>;
}

type Refused = { kind: "refused" };
type Unavailable = { kind: "unavailable" };
type Unknown = { kind: "unknown" };
type Malformed = { kind: "malformed" };
type TimedOut = { kind: "timed_out" };

export type PeriodsRead = { kind: "periods"; periods: FinancePeriods } | Unavailable;
export type PeriodRead = { kind: "period"; period: FinancePeriod } | { kind: "not_found" } | Unavailable;
export type CloseRead = { kind: "close"; close: FinanceClose } | { kind: "not_found" } | Unavailable;
export type RollupRequested = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: RollupAnswer };
export type Rehearsed = Refused | Unavailable | Unknown | Malformed | TimedOut | { kind: "answered"; answer: RehearseAnswer };
export type Closed = Refused | Unavailable | Unknown | Malformed | TimedOut | { kind: "unbalanced" } | { kind: "answered"; answer: CloseAnswer };
export type ExportDownloaded = Refused | Unavailable | Unknown | Malformed | { kind: "file"; file: CloseExportFile } | { kind: "answered"; answer: DownloadAnswer };
/** Dar el código otra vez para que las decisiones pasen su puerta (el bloque «Tu código»). */
export type PeriodsCode =
  | Refused
  | Unavailable
  | { kind: "verified" }
  | { kind: "wrong_code" }
  /** El freno rechazó: Auth cerró todas sus sesiones. */
  | { kind: "throttled" }
  /** Su código fue el bueno, y aun así ninguna decisión pasaría: es configuración. */
  | { kind: "not_available" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Un periodo con forma (`AAAAMM`, de 2000 a 2999, mes de 1 a 12), o nulo. */
export function periodOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  const year = Math.floor(value / 100);
  const month = value % 100;
  return year >= 2000 && year <= 2999 && month >= 1 && month <= 12 ? value : null;
}

/** Un identificador con forma, o nulo. Solo minúsculas: dos iguales se escriben igual. */
const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

export interface PeriodsCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  /** Dar el código del segundo factor (`team.ts`): el factor es el que dice la base. */
  giveSecondFactorCode: (jar: CookieJar, code: string) => Promise<CodeGiven>;
  store: PeriodStore;
}

export function createPeriodsPanel(deps: { report: (code: FailureCode) => Promise<void> }, core: PeriodsCore) {
  const { store } = core;

  /** Quien pide, si es del equipo con finanzas y su sesión pasa la puerta. */
  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "finance")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /**
   * Una lectura para la sección que ya pasó su guarda, con las claims que esa guarda dio. Leer no pide
   * el código reciente. Una lectura nula no vale: se le vuelve a preguntar a la guarda, y solo si insiste
   * en que pasa con finanzas se reporta. Las dos son «no se supo».
   */
  async function read<T>(reader: CookieReader, work: () => Promise<T | null>): Promise<{ ok: true; value: T } | { ok: false }> {
    let value: T | null;
    try {
      value = await work();
    } catch {
      await deps.report("periods_unavailable");
      return { ok: false };
    }
    if (value !== null) return { ok: true, value };
    const team = await core.teamStanding(reader);
    if (team.kind === "team" && holds(team.standing, "finance")) await deps.report("periods_unavailable");
    return { ok: false };
  }

  /** Una decisión: lo que la base contestó, o por qué no se supo. */
  async function decide<Answer>(work: () => Promise<Answer>): Promise<{ ok: true; answer: Answer } | { ok: false; result: Unknown | TimedOut | { kind: "unbalanced" } }> {
    try {
      return { ok: true, answer: await work() };
    } catch (error) {
      if (error instanceof CloseFailure && error.reason === "timed_out") {
        await deps.report("close_timed_out");
        return { ok: false, result: { kind: "timed_out" } };
      }
      if (error instanceof CloseFailure) {
        await deps.report("close_unbalanced");
        return { ok: false, result: { kind: "unbalanced" } };
      }
      await deps.report("period_change_unavailable");
      return { ok: false, result: { kind: "unknown" } };
    }
  }

  /** PA-78: todos los periodos. */
  async function financePeriods(reader: CookieReader, claims: VerifiedClaims): Promise<PeriodsRead> {
    const result = await read(reader, () => store.periods(claims));
    return result.ok ? { kind: "periods", periods: result.value } : { kind: "unavailable" };
  }

  /** PA-79: un periodo. Uno sin forma, o que la base no tiene, no existe. */
  async function financePeriod(reader: CookieReader, claims: VerifiedClaims, period: number): Promise<PeriodRead> {
    const valid = periodOf(period);
    if (valid === null) return { kind: "not_found" };
    const result = await read(reader, () => store.period(claims, valid));
    if (!result.ok) return { kind: "unavailable" };
    return result.value.period === null ? { kind: "not_found" } : { kind: "period", period: result.value };
  }

  /** PA-80: el ensayo y el cierre de un periodo. */
  async function financeClose(reader: CookieReader, claims: VerifiedClaims, period: number): Promise<CloseRead> {
    const valid = periodOf(period);
    if (valid === null) return { kind: "not_found" };
    const result = await read(reader, () => store.close(claims, valid));
    if (!result.ok) return { kind: "unavailable" };
    return result.value.period === null ? { kind: "not_found" } : { kind: "close", close: result.value };
  }

  /** Pedir el recálculo completo de un periodo (RF-408): lo corre un trabajo de cada minuto. */
  async function requestRollup(reader: CookieReader, input: { period: unknown }): Promise<RollupRequested> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const period = periodOf(input.period);
    if (period === null) return { kind: "malformed" };
    const result = await decide(() => store.requestRollup(admitted.claims, period));
    if (result.ok) return { kind: "answered", answer: result.answer };
    // Pedir no corre el cálculo: no vence ni descuadra.
    return { kind: "unknown" };
  }

  /** Ensayar el cierre (RF-503): no congela nada. */
  async function rehearse(reader: CookieReader, input: { period: unknown }): Promise<Rehearsed> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const period = periodOf(input.period);
    if (period === null) return { kind: "malformed" };
    const result = await decide(() => store.rehearse(admitted.claims, period));
    // El cálculo falló dentro de la base: quedó la corrida fallida, con su error, y alguien tiene que verlo.
    if (result.ok && result.answer === "failed") await deps.report("rehearsal_failed");
    if (result.ok) return { kind: "answered", answer: result.answer };
    // Un ensayo no confirma una suma: lo que no es el tiempo vencido es «no se supo».
    return result.result.kind === "timed_out" ? result.result : { kind: "unknown" };
  }

  /**
   * Cerrar el periodo (RF-502, RN-09): congela, y no se deshace. Cerrar otra vez contesta `already_closed`. Lleva el
   * ensayo que se tenía a la vista: sin él, o sin forma, no llega a la base (T-605, tercera solicitud).
   */
  async function closePeriod(reader: CookieReader, input: { period: unknown; run: unknown }): Promise<Closed> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const period = periodOf(input.period);
    const run = idOf(input.run);
    if (period === null || run === null) return { kind: "malformed" };
    const result = await decide(() => store.closePeriod(admitted.claims, period, run));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /** Descargar la exportación de un cierre (RF-509). Pide el código reciente, y cada descarga queda en la auditoría. */
  async function downloadExport(reader: CookieReader, input: { run: unknown }): Promise<ExportDownloaded> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const run = idOf(input.run);
    if (run === null) return { kind: "malformed" };
    const result = await decide(() => store.download(admitted.claims, run));
    if (!result.ok) return { kind: "unknown" };
    const answer = result.answer;
    if (answer.outcome === "ok") return { kind: "file", file: { filename: answer.filename, content: answer.content, rows: answer.rows, sha256: answer.sha256 } };
    return { kind: "answered", answer: answer.outcome };
  }

  /**
   * Dar el código otra vez (PA-79 y PA-80, «Tu código»). Lo comprueba con la lista de los periodos, que
   * pide finanzas.
   */
  async function givePeriodsCode(jar: CookieJar, code: string): Promise<PeriodsCode> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const given = await core.giveSecondFactorCode(jar, code);
    switch (given.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
      case "unavailable":
        return { kind: given.kind };
      default:
        // Dejó de ser del equipo, o su sesión ya no vale: decide la página.
        return { kind: "refused" };
    }
    // Con la sesión como quedó en ese tarro: verificar escribió su cookie.
    const again = await admit(jar);
    if (!again.ok) return again.result;
    let periods: FinancePeriods | null;
    try {
      periods = await store.periods(again.claims);
    } catch {
      await deps.report("period_change_unavailable");
      return { kind: "not_available" };
    }
    // Perdió finanzas entre una cosa y otra: decide la página.
    if (periods === null) return { kind: "refused" };
    if (periods.freshCode) return { kind: "verified" };
    await deps.report("period_change_unavailable");
    return { kind: "not_available" };
  }

  return { financePeriods, financePeriod, financeClose, requestRollup, rehearse, closePeriod, downloadExport, givePeriodsCode };
}
