import { describe, expect, it } from "vitest";

import { admin } from "@/messages/es/admin";
import { periodClosePath, periodPath, ROUTES } from "@/services/account/navigation";
import type { FinanceAlerts } from "@/services/anomalies/anomalies";
import type { FinanceClose, FinancePeriod, FinancePeriods, RunTeacher } from "@/services/periods/periods";

import { periodsButton } from "./outcomes";
import { acceptedCloseNotice, acceptedRollupNotice, closeView, money, percent, periodName, periodsView, periodView } from "./rows";

// Lo que PA-78 a PA-80 pintan, ya en palabras: qué cifra sale de dónde, qué se ofrece y qué falta para
// cerrar. Puro: sin servicios ni base.

const text = admin.periods;
const RUN = "c1000000-0000-4000-8000-000000000001";
const NOW = "2027-11-02T18:00:00.000Z";

type Period = Extract<FinancePeriod, { period: object }>;
type Close = Extract<FinanceClose, { period: object }>;

const figures = {
  runId: RUN,
  activeStudents: 120,
  poolBps: 6000,
  netRevenueCents: 2_000_000,
  poolCents: 1_200_000,
  assignedCents: 1_150_000,
  unconsumedCents: 50_000,
  carriedOutCents: 0,
};

function period(overrides: Partial<Period> = {}, status: Period["period"]["status"] = "closing"): Period {
  return {
    freshCode: true,
    period: {
      periodId: 202710,
      status,
      startsAt: "2027-10-01T06:00:00Z",
      endsAt: "2027-11-01T06:00:00Z",
      enteredClosingAt: status === "open" ? null : "2027-11-01T09:00:00Z",
      activeStudents: 120,
      poolBps: 6000,
      carriedInCents: 0,
      closedAt: null,
      payoutsReleasedAt: null,
      paidAt: null,
    },
    collected: { charges: 130, grossCents: 4_537_000, netCents: 3_911_200 },
    assigned: { students: 120, baseCents: 3_800_000 },
    close: null,
    rehearsal: { ...figures, studentPoolsCents: 1_200_000, at: "2027-11-02T10:00:00Z", statusAtRun: "closing" },
    openAlerts: 0,
    unconsumedAlertBps: 1500,
    unconsumedOver: false,
    lastRollup: { status: "succeeded", mode: "full", startedAt: "2027-11-02T09:00:00Z", finishedAt: "2027-11-02T09:05:00Z" },
    lastGoodRollup: { mode: "full", startedAt: "2027-11-02T09:00:00Z", finishedAt: "2027-11-02T09:05:00Z" },
    rollupRequest: null,
    ...overrides,
  };
}

const teacher = (overrides: Partial<RunTeacher> = {}): RunTeacher => ({
  teacherId: "7e000000-0000-4000-8000-000000000001",
  name: "Ana",
  assignedCents: 1_150_000,
  unconsumedCents: 50_000,
  totalCents: 1_200_000,
  founderBonusCents: 0,
  estimateCents: 1_200_000,
  belowMinimum: false,
  ...overrides,
});

function close(overrides: Partial<Close> = {}, status: Close["period"]["status"] = "closing"): Close {
  return {
    freshCode: true,
    period: { periodId: 202710, status, endsAt: "2027-11-01T06:00:00Z", enteredClosingAt: "2027-11-01T09:00:00Z" },
    checks: { openAlerts: 0, finalRehearsal: true, lastRollup: "succeeded", rollupMarks: false },
    rehearsal: { ...figures, at: "2027-11-02T10:00:00Z", status: "succeeded", statusAtRun: "closing", carriedInCents: 0, teachers: [teacher()] },
    close: null,
    ...overrides,
  };
}

describe("cómo se escriben", () => {
  it("el dinero, el porcentaje y el periodo", () => {
    expect(money(123_456_789)).toBe("$1,234,567.89");
    expect(money(-500)).toBe("-$5.00");
    expect(percent(6000)).toBe("60 %");
    expect(percent(6250)).toBe("62.5 %");
    expect(percent(1)).toBe("0.01 %");
    expect(periodName(202710)).toBe("octubre de 2027");
    expect(periodName(202601)).toBe("enero de 2026");
  });
});

describe("periodsView (PA-78)", () => {
  const list: FinancePeriods = {
    freshCode: true,
    periods: [
      {
        periodId: 202711,
        status: "open",
        startsAt: "2027-11-01T06:00:00Z",
        endsAt: "2027-12-01T06:00:00Z",
        activeStudents: null,
        poolBps: null,
        poolCents: null,
        unconsumedCents: null,
        rehearsedAt: null,
        payouts: { total: 0, paid: 0 },
      },
      {
        periodId: 202710,
        status: "closing",
        startsAt: "2027-10-01T06:00:00Z",
        endsAt: "2027-11-01T06:00:00Z",
        activeStudents: 120,
        poolBps: 6000,
        poolCents: 1_200_000,
        unconsumedCents: 50_000,
        rehearsedAt: "2027-11-02T10:00:00Z",
        payouts: { total: 0, paid: 0 },
      },
      {
        periodId: 202709,
        status: "paid",
        startsAt: "2027-09-01T06:00:00Z",
        endsAt: "2027-10-01T06:00:00Z",
        activeStudents: 110,
        poolBps: 6000,
        poolCents: 1_100_000,
        unconsumedCents: 0,
        rehearsedAt: null,
        payouts: { total: 3, paid: 3 },
      },
    ],
  };

  it("el periodo en curso va arriba, marcado, aunque la base lo dé en otro orden", () => {
    const view = periodsView({ ...list, periods: [list.periods[1]!, list.periods[0]!, list.periods[2]!] }, NOW);
    expect(view.rows.map((row) => [row.name, row.current])).toEqual([
      ["noviembre de 2027", true],
      ["octubre de 2027", false],
      ["septiembre de 2027", false],
    ]);
  });

  it("cada fila: su enlace, su estado con su tono y sus cifras", () => {
    const [open, closing, paid] = periodsView(list, NOW).rows;
    expect(open).toMatchObject({ href: periodPath(202711), status: text.statuses.open, tone: "neutral", students: text.noFigure, pool: text.noFigure });
    expect(closing).toMatchObject({
      status: text.statuses.closing,
      tone: "active",
      students: "120",
      pool: "$12,000.00",
      percent: "60 %",
      source: "Del ensayo del 2 de noviembre de 2027",
      payouts: "0 de 0",
    });
    expect(paid).toMatchObject({ status: text.statuses.paid, tone: "good", source: null, payouts: "3 de 3" });
  });
});

describe("periodView (PA-79)", () => {
  it("los pasos del periodo, con el actual marcado", () => {
    expect(periodView(period(), null, NOW).steps).toEqual([
      { label: text.statuses.open, current: false },
      { label: text.statuses.closing, current: true },
      { label: text.statuses.closed, current: false },
      { label: text.statuses.paid, current: false },
    ]);
  });

  it("las alertas sin revisar se avisan arriba", () => {
    expect(periodView(period({ openAlerts: 2 }), null, NOW).alertsWarning).toBe("Hay 2 alertas sin revisar. No se puede cerrar hasta revisarlas.");
    expect(periodView(period({ openAlerts: 1 }), null, NOW).alertsWarning).toBe("Hay 1 alerta sin revisar. No se puede cerrar hasta revisarla.");
    expect(periodView(period(), null, NOW).alertsWarning).toBeNull();
  });

  it("los dos ingresos, cada uno con su nombre; en un periodo abierto, parciales con su fecha", () => {
    const closing = periodView(period(), null, NOW);
    expect(closing.collected).toMatchObject({ value: "$45,370.00", context: "$39,112.00 sin IVA ni comisión, de 130 cobros.", tag: undefined });
    expect(closing.assigned).toMatchObject({ value: "$38,000.00", tag: undefined });
    const open = periodView(period({}, "open"), null, NOW);
    expect(open.collected.tag).toBe("Parcial, al 2 de noviembre de 2027");
    expect(open.assigned.tag).toBe("Parcial, al 2 de noviembre de 2027");
  });

  it("el bote, el porcentaje y el sin consumo salen del cierre, o del último ensayo con su fecha; si no hay, sin datos", () => {
    const rehearsed = periodView(period(), null, NOW);
    expect(rehearsed.pool.value).toBe("$12,000.00");
    expect(rehearsed.poolPercent.value).toBe("60 %");
    expect(rehearsed.unconsumed).toMatchObject({ value: "$500.00", context: "4.17 % del bote del mes. Umbral: 15 %.", tone: undefined });
    expect(rehearsed.figuresSource).toBe("Del ensayo del 2 de noviembre de 2027.");
    const partial = periodView(period({ rehearsal: { ...figures, at: "2027-10-20T10:00:00Z", statusAtRun: "open" } }, "open"), null, NOW);
    expect(partial.pool.tag).toBe("Parcial, del ensayo del 20 de octubre de 2027");
    const none = periodView(period({ rehearsal: null }), null, NOW);
    expect(none.pool.value).toBeNull();
    expect(none.figuresSource).toBe(text.figuresNeedRehearsal);
    const closed = periodView(
      period({ close: { ...figures, poolCents: 999_900 }, rehearsal: null }, "closed"),
      null,
      NOW,
    );
    expect(closed.pool.value).toBe("$9,999.00");
  });

  it("la consolidación: la última corrida; fallida, con la última que terminó bien", () => {
    expect(periodView(period(), null, NOW).rollup).toMatchObject({ last: expect.stringContaining("completa: terminó bien"), failed: null });
    const failed = periodView(
      period({ lastRollup: { status: "failed", mode: "dirty", startedAt: "2027-11-03T09:00:00Z", finishedAt: "2027-11-03T09:01:00Z" } }),
      null,
      NOW,
    );
    expect(failed.rollup.failed).toEqual([text.rollupFailed, expect.stringContaining("2 de noviembre de 2027")]);
    expect(periodView(period({ lastRollup: null, lastGoodRollup: null }), null, NOW).rollup.last).toBe(text.rollupNever);
  });

  it("recalcular se ofrece con el periodo abierto o en cierre, el código reciente y sin un pedido en curso", () => {
    expect(periodView(period(), null, NOW).rollup.button).toBe(periodsButton.rollup(202710));
    expect(periodView(period({}, "open"), null, NOW).rollup.button).toBe(periodsButton.rollup(202710));
    expect(periodView(period({ freshCode: false }), null, NOW).rollup.button).toBeNull();
    expect(periodView(period({}, "closed"), null, NOW).rollup.button).toBeNull();
    const pending = periodView(period({ rollupRequest: { status: "pending", requestedAt: "2027-11-02T11:00:00Z", startedAt: null, finishedAt: null } }), null, NOW);
    expect(pending.rollup.button).toBeNull();
    expect(pending.rollup.request).toMatch(/^Recálculo pedido el 2 de noviembre de 2027 a las/);
    const running = periodView(period({ rollupRequest: { status: "running", requestedAt: "2027-11-02T11:00:00Z", startedAt: "2027-11-02T11:01:00Z", finishedAt: null } }), null, NOW);
    expect(running.rollup.button).toBeNull();
    const done = periodView(period({ rollupRequest: { status: "succeeded", requestedAt: "2027-11-02T11:00:00Z", startedAt: "2027-11-02T11:01:00Z", finishedAt: "2027-11-02T11:04:00Z" } }), null, NOW);
    expect(done.rollup.button).toBe(periodsButton.rollup(202710));
    expect(done.rollup.request).toMatch(/^El último recálculo pedido terminó el 2 de noviembre de 2027/);
  });

  it("cerrado: solo lectura, y el enlace al cierre sigue", () => {
    const closed = periodView(period({ close: figures }, "closed"), null, NOW);
    expect(closed.readOnly).toBe(true);
    expect(closed.closeHref).toBe(periodClosePath(202710));
  });

  it("las alertas del periodo, de la lectura de las alertas; si no se pudo leer, se dice", () => {
    const alerts: FinanceAlerts = {
      freshCode: true,
      total: 2,
      alerts: [
        { id: "a1", period: 202710, kind: "teacher_points_jump", status: "open", teacherName: "Ana" },
        { id: "a2", period: 202709, kind: "impossible_completion", status: "open", teacherName: null },
      ] as never,
    };
    const view = periodView(period(), alerts, NOW);
    expect(view.alerts).toEqual({ kind: "rows", rows: [{ key: "a1", kind: expect.any(String), teacher: "Ana", status: admin.alerts.open, tone: "attention", href: ROUTES.alerts }] });
    expect(periodView(period(), null, NOW).alerts).toEqual({ kind: "unavailable" });
  });
});

describe("closeView (PA-80)", () => {
  it("el último ensayo: con datos finales o parcial, o fallido", () => {
    expect(closeView(close()).rehearsal).toMatchObject({ banner: text.finalBanner, failed: false });
    expect(closeView(close({ rehearsal: { ...close().rehearsal!, statusAtRun: "open" } }, "open")).rehearsal).toMatchObject({ banner: text.partialBanner });
    const failed = closeView(close({ rehearsal: { ...close().rehearsal!, status: "failed", poolCents: null, teachers: [] } }));
    expect(failed.rehearsal).toMatchObject({ failed: true, banner: text.rehearsalFailedBanner });
    expect(failed.lastRehearsal).toMatch(/Falló\.$/);
    expect(closeView(close({ rehearsal: null })).lastRehearsal).toBe(text.noRehearsal);
  });

  it("la suma repartida contra el bote, al centavo", () => {
    expect(closeView(close()).rehearsal?.sum).toMatchObject({ value: "$12,000.00", ok: true });
    const off = close({ rehearsal: { ...close().rehearsal!, teachers: [teacher({ totalCents: 1_199_999 })] } });
    expect(closeView(off).rehearsal?.sum).toMatchObject({ ok: false });
    const carried = close({ rehearsal: { ...close().rehearsal!, carriedOutCents: 100, teachers: [teacher({ totalCents: 1_199_900 })] } });
    expect(closeView(carried).rehearsal?.sum).toMatchObject({ ok: true, carried: "$1.00 pasan al periodo siguiente." });
  });

  it("sin nada asignado: el bote entero pasa al siguiente", () => {
    const empty = close({ rehearsal: { ...close().rehearsal!, assignedCents: 0, unconsumedCents: 1_200_000, carriedOutCents: 1_200_000, teachers: [] } });
    expect(closeView(empty).rehearsal?.nothingAssigned).toBe(true);
  });

  it("la tabla por maestro: lo que queda y los totales", () => {
    const view = closeView(
      close({
        rehearsal: {
          ...close().rehearsal!,
          teachers: [teacher({ totalCents: 600_000, belowMinimum: false }), teacher({ teacherId: "x", name: null, totalCents: 600_000, founderBonusCents: 10_000, belowMinimum: true })],
        },
      }),
    );
    expect(view.rehearsal?.teachers.map((row) => [row.name, row.remains, row.bonus])).toEqual([
      ["Ana", text.toPay, ""],
      [text.noName, text.belowMinimum, "$100.00"],
    ]);
    expect(view.rehearsal?.totals).toMatchObject({ total: "$12,000.00", bonus: "$100.00" });
    const unknown = closeView(close({ rehearsal: { ...close().rehearsal!, teachers: [teacher({ belowMinimum: null })] } }));
    expect(unknown.rehearsal?.teachers[0]?.remains).toBe(text.unknownRemains);
  });

  it("la lista de lo que falta para cerrar, y cerrar solo con la lista completa", () => {
    const ready = closeView(close());
    expect(ready.checks.every((check) => check.done)).toBe(true);
    expect(ready.close).toEqual({ kind: "ready", run: RUN, button: periodsButton.askClose(202710, RUN), confirm: periodsButton.close(202710, RUN) });
    const missing = closeView(close({ checks: { openAlerts: 2, finalRehearsal: false, lastRollup: "failed", rollupMarks: true } }));
    expect(missing.checks.filter((check) => !check.done).map((check) => check.label)).toEqual([
      text.checks.rollupFailed,
      text.checks.marksPending,
      "Todas las alertas revisadas: faltan 2",
      text.checks.finalRehearsalMissing,
    ]);
    expect(missing.checks.find((check) => check.label.startsWith("Todas"))?.href).toBe(ROUTES.alerts);
    expect(missing.close).toEqual({ kind: "waits" });
    expect(closeView(close({ checks: { ...close().checks, lastRollup: "running" } })).checks.some((check) => check.label === text.checks.rollupRunning)).toBe(true);
    expect(closeView(close({ checks: { ...close().checks, lastRollup: null } })).checks.some((check) => check.label === text.checks.rollupNone)).toBe(true);
  });

  it("el mes no ha terminado: no hay botón de cerrar, solo se ensaya", () => {
    const open = closeView(close({}, "open"));
    expect(open.close).toEqual({ kind: "month_open" });
    expect(open.rehearse).toBe(periodsButton.rehearse(202710));
  });

  it("sin el código reciente, ni ensayar ni cerrar se ofrecen", () => {
    const locked = closeView(close({ freshCode: false }));
    expect(locked.rehearse).toBeNull();
    expect(locked.close).toEqual({ kind: "waits" });
  });

  it("cerrado: solo lectura, quién cerró, las cifras del cierre y la descarga", () => {
    const run = {
      ...figures,
      at: "2027-11-03T18:00:00Z",
      closedBy: "Finanzas",
      export: { rows: 1, sha256: "ab".repeat(32), createdAt: "2027-11-03T18:00:00Z" },
      teachers: [teacher()],
    };
    const closed = closeView(close({ close: run }, "closed"));
    expect(closed.rehearse).toBeNull();
    expect(closed.close).toEqual({ kind: "closed" });
    expect(closed.closedLine).toMatch(/^Cerrado el 3 de noviembre de 2027 a las .* por Finanzas\.$/);
    expect(closed.result?.teachers).toHaveLength(1);
    expect(closed.download).toEqual({ kind: "offered", button: periodsButton.download(RUN) });
    expect(closeView(close({ freshCode: false, close: run }, "closed")).download).toEqual({ kind: "locked" });
    expect(closeView(close({ close: { ...run, export: null } }, "closed")).download).toEqual({ kind: "missing" });
    expect(closeView(close({ close: { ...run, closedBy: null } }, "closed")).closedLine).toMatch(/^Cerrado el 3 de noviembre de 2027 a las [^,]*\.$/);
  });
});

describe("los avisos de lo que salió bien son del periodo que se ve (revisión de la 70)", () => {
  it("«Periodo cerrado» solo en un periodo cerrado", () => {
    const run = { ...figures, at: "2027-11-02T17:59:30Z", closedBy: null, export: null, teachers: [] };
    expect(acceptedCloseNotice("period_closed", close({ close: run }, "closed"), NOW)).toBe(true);
    expect(acceptedCloseNotice("period_closed", close(), NOW)).toBe(false);
  });

  it("«Ensayo listo» solo si su último ensayo es de hace un momento", () => {
    const at = (iso: string) => close({ rehearsal: { ...close().rehearsal!, at: iso } });
    expect(acceptedCloseNotice("period_rehearsed", at("2027-11-02T17:59:30Z"), NOW)).toBe(true);
    expect(acceptedCloseNotice("period_rehearsed", at("2027-11-02T17:50:00Z"), NOW)).toBe(false);
    expect(acceptedCloseNotice("period_rehearsed", close({ rehearsal: null }), NOW)).toBe(false);
    expect(acceptedCloseNotice(null, close(), NOW)).toBe(false);
  });

  it("«Recálculo pedido» solo si su último pedido es de hace un momento", () => {
    const asked = (iso: string) => period({ rollupRequest: { status: "pending", requestedAt: iso, startedAt: null, finishedAt: null } });
    expect(acceptedRollupNotice(asked("2027-11-02T17:59:30Z"), NOW)).toBe(true);
    // Uno viejo que ya terminó no es de este envío.
    expect(
      acceptedRollupNotice(
        period({ rollupRequest: { status: "succeeded", requestedAt: "2027-11-02T17:50:00Z", startedAt: "2027-11-02T17:51:00Z", finishedAt: "2027-11-02T17:55:00Z" } }),
        NOW,
      ),
    ).toBe(false);
    expect(acceptedRollupNotice(period(), NOW)).toBe(false);
  });
});

describe("cerrar solo con el reparto a la vista (revisión de la 70)", () => {
  it("si el último ensayo falló, aunque haya uno bueno antes, la lista lo dice y no se ofrece cerrar", () => {
    const failed = closeView(close({ rehearsal: { ...close().rehearsal!, status: "failed", poolCents: null, teachers: [] } }));
    expect(failed.checks.find((check) => !check.done)?.label).toBe(text.checks.rehearsalFailed);
    expect(failed.close).toEqual({ kind: "waits" });
  });

  it("si el último ensayo es parcial, no se ofrece cerrar", () => {
    const partial = closeView(close({ rehearsal: { ...close().rehearsal!, statusAtRun: "open" } }));
    expect(partial.close).toEqual({ kind: "waits" });
    expect(partial.checks.some((check) => check.label === text.checks.finalRehearsalMissing && !check.done)).toBe(true);
  });

  it("si la suma no cuadra, la lista lo dice y no se ofrece cerrar", () => {
    const off = closeView(close({ rehearsal: { ...close().rehearsal!, teachers: [teacher({ totalCents: 1_199_999 })] } }));
    expect(off.checks.find((check) => !check.done)?.label).toBe(text.checks.sumOff);
    expect(off.close).toEqual({ kind: "waits" });
    expect(closeView(close()).checks.some((check) => check.label === text.checks.sumOk && check.done)).toBe(true);
  });
});

describe("lo asignado a un periodo cerrado es lo que congeló el cierre (revisión de la 70)", () => {
  it("cerrado: el ingreso neto del cierre, no la suma de ahora", () => {
    const closed = periodView(period({ close: { ...figures, netRevenueCents: 3_700_000 }, rehearsal: null }, "closed"), null, NOW);
    expect(closed.assigned.value).toBe("$37,000.00");
    expect(periodView(period(), null, NOW).assigned.value).toBe("$38,000.00");
  });
});

describe("los avisos, más finos (segunda revisión de la 70)", () => {
  const run = { ...figures, closedBy: null, export: null, teachers: [] };
  it("«Periodo cerrado» solo si este cierre es de hace un momento", () => {
    expect(acceptedCloseNotice("period_closed", close({ close: { ...run, at: "2027-11-02T17:59:30Z" } }, "closed"), NOW)).toBe(true);
    expect(acceptedCloseNotice("period_closed", close({ close: { ...run, at: "2027-08-02T17:59:30Z" } }, "closed"), NOW)).toBe(false);
    expect(acceptedCloseNotice("period_closed", close({ close: { ...run, at: null } }, "closed"), NOW)).toBe(false);
  });

  it("«Ensayo listo» no sale junto a un ensayo que falló", () => {
    const failed = close({ rehearsal: { ...close().rehearsal!, at: "2027-11-02T17:59:30Z", status: "failed" } });
    expect(acceptedCloseNotice("period_rehearsed", failed, NOW)).toBe(false);
  });

  it("la ventana del aviso: hasta un minuto y medio antes, y unos segundos después por el reloj", () => {
    const at = (iso: string) => close({ rehearsal: { ...close().rehearsal!, at: iso } });
    expect(acceptedCloseNotice("period_rehearsed", at("2027-11-02T17:58:31Z"), NOW)).toBe(true);
    expect(acceptedCloseNotice("period_rehearsed", at("2027-11-02T17:58:29Z"), NOW)).toBe(false);
    expect(acceptedCloseNotice("period_rehearsed", at("2027-11-02T18:00:04Z"), NOW)).toBe(true);
    expect(acceptedCloseNotice("period_rehearsed", at("2027-11-02T18:00:06Z"), NOW)).toBe(false);
  });

  it("«Recálculo pedido» también con un pedido viejo que sigue pendiente o corriendo (ya pedido)", () => {
    const old = (status: "pending" | "running" | "succeeded") =>
      period({ rollupRequest: { status, requestedAt: "2027-11-02T08:30:00Z", startedAt: status === "pending" ? null : "2027-11-02T09:31:00Z", finishedAt: null } });
    expect(acceptedRollupNotice(old("pending"), NOW)).toBe(true);
    expect(acceptedRollupNotice(old("running"), NOW)).toBe(true);
    expect(acceptedRollupNotice(old("succeeded"), NOW)).toBe(false);
  });

  it("cerrado: lo asignado no dice un conteo de alumnos de ahora", () => {
    const closed = periodView(period({ close: { ...figures, netRevenueCents: 3_700_000 }, rehearsal: null }, "closed"), null, NOW);
    expect(closed.assigned.context).toBe(text.assignedClosedContext);
  });
});

describe("el umbral del bote sin consumo en PA-79 (T-605, tercera solicitud)", () => {
  it("sobre el bote del mes, sin lo que pasó del anterior, como la alerta", () => {
    const carried = periodView(
      period({ rehearsal: { ...figures, poolCents: 1_300_000, unconsumedCents: 150_000, studentPoolsCents: 1_200_000, at: "2027-11-02T10:00:00Z", statusAtRun: "closing" } }),
      null,
      NOW,
    );
    // La cifra es la del mes, como el porcentaje; lo que pasó del anterior se dice aparte (revisión de la 72).
    expect(carried.unconsumed.value).toBe("$500.00");
    expect(carried.unconsumed.context).toBe("4.17 % del bote del mes. Umbral: 15 %. Sin contar $1,000.00 que pasaron del periodo anterior.");
  });

  it("en tono de atención solo si la base dice que lo pasa", () => {
    expect(periodView(period({ unconsumedOver: true }), null, NOW).unconsumed.tone).toBe("attention");
    expect(periodView(period({ unconsumedOver: null }), null, NOW).unconsumed.tone).toBeUndefined();
  });

  it("sin umbral válido, el contexto no lo nombra", () => {
    expect(periodView(period({ unconsumedAlertBps: null }), null, NOW).unconsumed.context).toBe("4.17 % del bote del mes.");
  });
});
