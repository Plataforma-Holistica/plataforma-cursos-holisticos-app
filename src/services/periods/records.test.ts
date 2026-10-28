import { describe, expect, it } from "vitest";

import { closeAnswerOf, closeReadOf, downloadOf, periodReadOf, periodsReadOf, rehearseAnswerOf, rollupAnswerOf } from "./records";

// Lo que se acepta de la base para PA-78 a PA-80: la forma exacta, y nada más. Un campo que este código
// no conoce (un identificador de un alumno que alguien agregue a una lectura) hace fallar la lectura en
// vez de llegar a la pantalla.

const RUN = "c1000000-0000-4000-8000-000000000001";
const TEACHER = "7e000000-0000-4000-8000-000000000001";
const PERIOD_ROW = {
  period_id: 202710,
  status: "closing",
  starts_at: "2027-10-01T06:00:00+00:00",
  ends_at: "2027-11-01T06:00:00+00:00",
  active_students: 120,
  pool_bps: 6000,
  pool_cents: 1_234_500,
  unconsumed_cents: 4_500,
  rehearsed_at: "2027-11-02T10:00:00+00:00",
  payouts: { total: 0, paid: 0 },
};
const FIGURES = {
  run_id: RUN,
  active_students: 120,
  pool_bps: 6000,
  net_revenue_cents: 2_000_000,
  pool_cents: 1_234_500,
  assigned_cents: 1_230_000,
  unconsumed_cents: 4_500,
  carried_out_cents: 0,
};
const PERIOD = {
  fresh_code: false,
  period: {
    period_id: 202710,
    status: "closing",
    starts_at: "2027-10-01T06:00:00+00:00",
    ends_at: "2027-11-01T06:00:00+00:00",
    entered_closing_at: "2027-11-01T09:00:00+00:00",
    active_students: 120,
    pool_bps: 6000,
    carried_in_cents: 0,
    closed_at: null,
    payouts_released_at: null,
    paid_at: null,
  },
  collected: { charges: 130, gross_mxn_cents: 4_537_000, revenue_net_mxn_cents: 3_911_200 },
  assigned: { students: 120, base_cents: 3_800_000 },
  close: null,
  rehearsal: { ...FIGURES, at: "2027-11-02T10:00:00+00:00", period_status_at_run: "closing" },
  open_alerts: 2,
  last_rollup: { status: "failed", mode: "dirty", started_at: "2027-11-02T09:00:00+00:00", finished_at: "2027-11-02T09:01:00+00:00" },
  last_good_rollup: { mode: "full", started_at: "2027-11-01T09:00:00+00:00", finished_at: "2027-11-01T09:05:00+00:00" },
  rollup_request: { status: "pending", requested_at: "2027-11-02T11:00:00+00:00", started_at: null, finished_at: null },
};
const TEACHER_ROW = {
  teacher_id: TEACHER,
  name: "Maestra",
  assigned_cents: 600_000,
  unconsumed_cents: 2_000,
  total_cents: 602_000,
  founder_bonus_cents: 0,
  estimate_cents: 602_000,
  below_minimum: false,
};
const CLOSE = {
  fresh_code: true,
  period: { period_id: 202710, status: "closed", ends_at: "2027-11-01T06:00:00+00:00", entered_closing_at: "2027-11-01T09:00:00+00:00" },
  checks: { open_alerts: 0, final_rehearsal: true, last_rollup: "succeeded", rollup_marks: false },
  rehearsal: {
    ...FIGURES,
    at: "2027-11-02T10:00:00+00:00",
    status: "succeeded",
    period_status_at_run: "closing",
    carried_in_cents: 0,
    teachers: [{ ...TEACHER_ROW, below_minimum: null }],
  },
  close: {
    ...FIGURES,
    at: "2027-11-03T10:00:00+00:00",
    closed_by: "Finanzas",
    export: { rows: 1, sha256: "ab".repeat(32), created_at: "2027-11-03T10:00:00+00:00" },
    teachers: [TEACHER_ROW],
  },
};

describe("periodsReadOf", () => {
  it("toma la forma exacta, en camello", () => {
    expect(periodsReadOf({ fresh_code: true, periods: [PERIOD_ROW] })).toEqual({
      freshCode: true,
      periods: [
        {
          periodId: 202710,
          status: "closing",
          startsAt: PERIOD_ROW.starts_at,
          endsAt: PERIOD_ROW.ends_at,
          activeStudents: 120,
          poolBps: 6000,
          poolCents: 1_234_500,
          unconsumedCents: 4_500,
          rehearsedAt: PERIOD_ROW.rehearsed_at,
          payouts: { total: 0, paid: 0 },
        },
      ],
    });
  });

  it("nulo es nulo; un campo de más, un estado desconocido o una cifra de texto lanzan", () => {
    expect(periodsReadOf(null)).toBeNull();
    expect(() => periodsReadOf({ fresh_code: true, periods: [{ ...PERIOD_ROW, student_id: TEACHER }] })).toThrow();
    expect(() => periodsReadOf({ fresh_code: true, periods: [{ ...PERIOD_ROW, status: "reopened" }] })).toThrow();
    expect(() => periodsReadOf({ fresh_code: true, periods: [{ ...PERIOD_ROW, pool_cents: "12" }] })).toThrow();
    expect(() => periodsReadOf({ fresh_code: true, periods: [{ ...PERIOD_ROW, pool_cents: 1.5 }] })).toThrow();
  });
});

describe("periodReadOf", () => {
  it("toma la forma exacta, en camello", () => {
    const read = periodReadOf(PERIOD);
    expect(read).toMatchObject({
      freshCode: false,
      period: { periodId: 202710, status: "closing", enteredClosingAt: PERIOD.period.entered_closing_at, carriedInCents: 0 },
      collected: { charges: 130, grossCents: 4_537_000, netCents: 3_911_200 },
      assigned: { students: 120, baseCents: 3_800_000 },
      close: null,
      rehearsal: { runId: RUN, at: PERIOD.rehearsal.at, statusAtRun: "closing", poolCents: 1_234_500 },
      openAlerts: 2,
      lastRollup: { status: "failed", mode: "dirty" },
      lastGoodRollup: { mode: "full", startedAt: PERIOD.last_good_rollup.started_at },
      rollupRequest: { status: "pending", requestedAt: PERIOD.rollup_request.requested_at, startedAt: null },
    });
  });

  it("sin el periodo: solo eso", () => {
    expect(periodReadOf({ fresh_code: true, period: null })).toEqual({ freshCode: true, period: null });
    expect(() => periodReadOf({ fresh_code: true, period: null, open_alerts: 0 })).toThrow();
  });

  it("nulo es nulo; un campo de más lanza", () => {
    expect(periodReadOf(null)).toBeNull();
    expect(() => periodReadOf({ ...PERIOD, students: [] })).toThrow();
    expect(() => periodReadOf({ ...PERIOD, rollup_request: { ...PERIOD.rollup_request, requested_by: TEACHER } })).toThrow();
  });
});

describe("closeReadOf", () => {
  it("toma la forma exacta, en camello", () => {
    expect(closeReadOf(CLOSE)).toMatchObject({
      freshCode: true,
      period: { periodId: 202710, status: "closed" },
      checks: { openAlerts: 0, finalRehearsal: true, lastRollup: "succeeded", rollupMarks: false },
      rehearsal: { status: "succeeded", teachers: [{ teacherId: TEACHER, belowMinimum: null }] },
      close: {
        closedBy: "Finanzas",
        export: { rows: 1, sha256: "ab".repeat(32) },
        teachers: [{ teacherId: TEACHER, name: "Maestra", totalCents: 602_000, estimateCents: 602_000, belowMinimum: false }],
      },
    });
  });

  it("un ensayo fallido llega sin cifras; con el texto del error, lanza", () => {
    const failed = {
      ...CLOSE.rehearsal,
      status: "failed",
      active_students: null,
      pool_bps: null,
      net_revenue_cents: null,
      pool_cents: null,
      assigned_cents: null,
      unconsumed_cents: null,
      carried_in_cents: null,
      carried_out_cents: null,
      teachers: [],
    };
    expect(closeReadOf({ ...CLOSE, rehearsal: failed })).toMatchObject({ rehearsal: { status: "failed", poolCents: null } });
    expect(() => closeReadOf({ ...CLOSE, rehearsal: { ...failed, error: "division by zero" } })).toThrow();
  });

  it("nulo es nulo; sin periodo, solo eso", () => {
    expect(closeReadOf(null)).toBeNull();
    expect(closeReadOf({ fresh_code: false, period: null })).toEqual({ freshCode: false, period: null });
  });
});

describe("las respuestas", () => {
  it("las de su lista pasan; otra lanza", () => {
    expect(rollupAnswerOf("requested")).toBe("requested");
    expect(rehearseAnswerOf("rehearsed")).toBe("rehearsed");
    expect(rehearseAnswerOf("too_soon")).toBe("too_soon");
    expect(closeAnswerOf("rehearsal_stale")).toBe("rehearsal_stale");
    expect(() => closeAnswerOf("closing")).toThrow();
    expect(() => rehearseAnswerOf(null)).toThrow();
    expect(() => rollupAnswerOf("closed")).toThrow();
  });

  it("la descarga: el archivo entero, o una respuesta de su lista", () => {
    const file = { outcome: "ok", period_id: 202710, filename: "cierre-2027-10.csv", rows: 1, format_version: 1, content: "x", sha256: "ab".repeat(32) };
    expect(downloadOf(file)).toEqual({ outcome: "ok", filename: "cierre-2027-10.csv", rows: 1, content: "x", sha256: "ab".repeat(32) });
    expect(downloadOf({ outcome: "not_found" })).toEqual({ outcome: "not_found" });
    expect(() => downloadOf({ ...file, format_version: 2 })).toThrow();
    expect(() => downloadOf({ ...file, filename: "../x.csv" })).toThrow();
    expect(() => downloadOf({ ...file, extra: 1 })).toThrow();
    expect(() => downloadOf({ outcome: "malformed" })).toThrow();
  });
});
