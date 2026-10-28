import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, CodeGiven, TeamCheck, TeamStanding } from "@/services/account/team";

import { CloseFailure, createPeriodsPanel, type FinanceClose, type FinancePeriod, type FinancePeriods, type PeriodStore } from "./panel";

// El panel del periodo, el ensayo y el cierre, con todo lo de fuera simulado: a quién se le pregunta
// qué, en qué orden, y qué se decide con cada respuesta. Contra la base de verdad, en
// `tests/integration/56-periodos.test.ts` y `supabase/tests/51_panel_del_periodo.test.sql`.

const ME = "a0000000-0000-4000-8000-000000000001";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const RUN = "c1000000-0000-4000-8000-000000000001";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const PERIODS: FinancePeriods = { freshCode: true, periods: [] };
// Solo importa que traigan un periodo: sin él, la base no lo tiene.
const PERIOD = { freshCode: true, period: { periodId: 202710 } } as unknown as FinancePeriod;
const CLOSE = { freshCode: true, period: { periodId: 202710 } } as unknown as FinanceClose;
const EXPORT = { filename: "cierre-2027-10.csv", content: "﻿periodo\r\n", rows: 0, sha256: "ab".repeat(32) };

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["finance"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

type Behavior = "throws" | CloseFailure;

function serviceWith(
  setup: {
    check?: TeamCheck | TeamCheck[];
    periods?: FinancePeriods | null | "throws";
    period?: FinancePeriod | null | "throws";
    close?: FinanceClose | null | "throws";
    answer?: string | Behavior;
    download?: { outcome: string } | Behavior;
    code?: CodeGiven;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const checks = Array.isArray(setup.check) ? [...setup.check] : null;
  const answer = () => {
    if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
    if (setup.answer instanceof CloseFailure) return Promise.reject(setup.answer);
    return Promise.resolve((setup.answer ?? "rehearsed") as never);
  };
  const read = <T>(value: T | null | "throws" | undefined, fallback: T) => {
    if (value === "throws") return Promise.reject(new Error("sin base"));
    return Promise.resolve(value === undefined ? fallback : value);
  };
  const store: PeriodStore = {
    periods: vi.fn(() => {
      calls.push("periodos");
      return read(setup.periods, PERIODS);
    }),
    period: vi.fn((_claims, period: number) => {
      calls.push(`periodo ${period}`);
      return read(setup.period, PERIOD);
    }),
    close: vi.fn((_claims, period: number) => {
      calls.push(`cierre ${period}`);
      return read(setup.close, CLOSE);
    }),
    requestRollup: vi.fn((_claims, period: number) => {
      calls.push(`recalcular ${period}`);
      return answer();
    }),
    rehearse: vi.fn((_claims, period: number) => {
      calls.push(`ensayar ${period}`);
      return answer();
    }),
    closePeriod: vi.fn((_claims, period: number, run: string) => {
      calls.push(`cerrar ${period} ${run}`);
      return answer();
    }),
    download: vi.fn((_claims, run: string) => {
      calls.push(`descargar ${run}`);
      if (setup.download === "throws") return Promise.reject(new Error("sin base"));
      if (setup.download instanceof CloseFailure) return Promise.reject(setup.download);
      const outcome = setup.download ?? { outcome: "ok" };
      return Promise.resolve((outcome.outcome === "ok" ? { outcome: "ok", ...EXPORT } : outcome) as never);
    }),
  };
  const teamStanding = vi.fn(() => {
    calls.push("guarda");
    return Promise.resolve(checks ? (checks.shift() ?? teamCheck()) : (setup.check as TeamCheck | undefined) ?? teamCheck());
  });
  const giveSecondFactorCode = vi.fn(() => {
    calls.push("código");
    return Promise.resolve(setup.code ?? ({ kind: "verified" } as CodeGiven));
  });
  const service = createPeriodsPanel(
    {
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { teamStanding, giveSecondFactorCode, store },
  );
  return { ...service, calls, reported, store };
}

const reader = { get: () => undefined };
const jar = { get: () => undefined, set: () => undefined, delete: () => undefined };

describe("las lecturas", () => {
  it("leen con las claims que la guarda dio, sin volver a correrla", async () => {
    const service = serviceWith();
    expect(await service.financePeriods(reader, claims)).toEqual({ kind: "periods", periods: PERIODS });
    expect(await service.financePeriod(reader, claims, 202710)).toEqual({ kind: "period", period: PERIOD });
    expect(await service.financeClose(reader, claims, 202710)).toEqual({ kind: "close", close: CLOSE });
    expect(service.calls).toEqual(["periodos", "periodo 202710", "cierre 202710"]);
  });

  it("nula, y la guarda ya no la deja pasar con finanzas: no se supo, sin reportar", async () => {
    const service = serviceWith({ periods: null, period: null, close: null, check: teamCheck(standingOf(["content"])) });
    expect(await service.financePeriods(reader, claims)).toEqual({ kind: "unavailable" });
    expect(await service.financePeriod(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(await service.financeClose(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual([]);
  });

  it("nula, y la guarda insiste en que pasa: se reporta", async () => {
    const service = serviceWith({ periods: null, period: null, close: null });
    expect(await service.financePeriods(reader, claims)).toEqual({ kind: "unavailable" });
    expect(await service.financePeriod(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(await service.financeClose(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["periods_unavailable", "periods_unavailable", "periods_unavailable"]);
  });

  it("si la lectura lanza, se reporta", async () => {
    const service = serviceWith({ periods: "throws", period: "throws", close: "throws" });
    expect(await service.financePeriods(reader, claims)).toEqual({ kind: "unavailable" });
    expect(await service.financePeriod(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(await service.financeClose(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["periods_unavailable", "periods_unavailable", "periods_unavailable"]);
    expect(service.calls).not.toContain("guarda");
  });

  it("un periodo sin forma no llega a la base: no existe", async () => {
    const service = serviceWith();
    for (const period of [0, 202700, 202713, 199912, 300001, 202710.5, Number.NaN]) {
      expect(await service.financePeriod(reader, claims, period)).toEqual({ kind: "not_found" });
      expect(await service.financeClose(reader, claims, period)).toEqual({ kind: "not_found" });
    }
    expect(service.calls).toEqual([]);
  });

  it("un periodo con forma que la base no tiene: no existe", async () => {
    const service = serviceWith({ period: { freshCode: true, period: null }, close: { freshCode: true, period: null } });
    expect(await service.financePeriod(reader, claims, 202710)).toEqual({ kind: "not_found" });
    expect(await service.financeClose(reader, claims, 202710)).toEqual({ kind: "not_found" });
  });
});

describe("las decisiones: la guarda primero", () => {
  const decisions = (service: ReturnType<typeof serviceWith>) => [
    () => service.requestRollup(reader, { period: 202710 }),
    () => service.rehearse(reader, { period: 202710 }),
    () => service.closePeriod(reader, { period: 202710, run: RUN }),
    () => service.downloadExport(reader, { run: RUN }),
  ];

  it("sin finanzas: refused, sin preguntarle nada a la base", async () => {
    const service = serviceWith({ check: teamCheck(standingOf(["content"])) });
    for (const decide of decisions(service)) expect(await decide()).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda", "guarda", "guarda", "guarda"]);
  });

  it("si no se supo quién pide: unavailable, sin preguntarle a la base", async () => {
    const service = serviceWith({ check: { kind: "unavailable" } as TeamCheck });
    for (const decide of decisions(service)) expect(await decide()).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["guarda", "guarda", "guarda", "guarda"]);
  });

  it("sin sesión del equipo: refused", async () => {
    const service = serviceWith({ check: { kind: "not_team" } as unknown as TeamCheck });
    for (const decide of decisions(service)) expect(await decide()).toEqual({ kind: "refused" });
  });

  it("un periodo o una corrida sin forma no llegan a la base", async () => {
    const service = serviceWith();
    for (const period of ["202710", null, 202713, 2027.1, undefined]) {
      expect(await service.requestRollup(reader, { period })).toEqual({ kind: "malformed" });
      expect(await service.rehearse(reader, { period })).toEqual({ kind: "malformed" });
      expect(await service.closePeriod(reader, { period, run: RUN })).toEqual({ kind: "malformed" });
    }
    for (const run of ["no", RUN.toUpperCase(), 7, null]) expect(await service.downloadExport(reader, { run })).toEqual({ kind: "malformed" });
    // Cerrar sin decir qué ensayo se tenía a la vista, o con uno sin forma, no llega a la base (T-605, tercera solicitud).
    for (const run of ["no", RUN.toUpperCase(), 7, null, undefined]) expect(await service.closePeriod(reader, { period: 202710, run })).toEqual({ kind: "malformed" });
    expect(service.calls.filter((call) => call !== "guarda")).toEqual([]);
  });
});

describe("lo que contesta la base", () => {
  it("recalcular: la respuesta de su lista", async () => {
    for (const answer of ["requested", "already_requested", "not_rollable", "malformed", "forbidden", "needs_fresh_code"]) {
      const service = serviceWith({ answer });
      expect(await service.requestRollup(reader, { period: 202710 })).toEqual({ kind: "answered", answer });
      expect(service.calls).toEqual(["guarda", "recalcular 202710"]);
    }
  });

  it("ensayar y cerrar: la respuesta de su lista", async () => {
    const rehearse = serviceWith({ answer: "too_soon" });
    expect(await rehearse.rehearse(reader, { period: 202710 })).toEqual({ kind: "answered", answer: "too_soon" });
    const superseded = serviceWith({ answer: "rehearsal_superseded" });
    expect(await superseded.closePeriod(reader, { period: 202710, run: RUN })).toEqual({ kind: "answered", answer: "rehearsal_superseded" });
    const close = serviceWith({ answer: "rehearsal_stale" });
    expect(await close.closePeriod(reader, { period: 202710, run: RUN })).toEqual({ kind: "answered", answer: "rehearsal_stale" });
    expect(close.calls).toEqual(["guarda", `cerrar 202710 ${RUN}`]);
  });

  it("un ensayo que falló dentro de la base se dice como tal, y se reporta", async () => {
    const service = serviceWith({ answer: "failed" });
    expect(await service.rehearse(reader, { period: 202710 })).toEqual({ kind: "answered", answer: "failed" });
    expect(service.reported).toEqual(["rehearsal_failed"]);
  });

  it("si lanza: no se supo, y se reporta; nunca se pinta como hecho", async () => {
    const service = serviceWith({ answer: "throws", download: "throws" });
    expect(await service.requestRollup(reader, { period: 202710 })).toEqual({ kind: "unknown" });
    expect(await service.rehearse(reader, { period: 202710 })).toEqual({ kind: "unknown" });
    expect(await service.closePeriod(reader, { period: 202710, run: RUN })).toEqual({ kind: "unknown" });
    expect(await service.downloadExport(reader, { run: RUN })).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(Array(4).fill("period_change_unavailable"));
  });

  it("el tiempo vencido del ensayo o del cierre se dice como tal, y se reporta", async () => {
    const service = serviceWith({ answer: new CloseFailure("timed_out") });
    expect(await service.rehearse(reader, { period: 202710 })).toEqual({ kind: "timed_out" });
    expect(await service.closePeriod(reader, { period: 202710, run: RUN })).toEqual({ kind: "timed_out" });
    expect(service.reported).toEqual(["close_timed_out", "close_timed_out"]);
  });

  it("la suma que no cuadra al confirmar el cierre se dice como tal, y se reporta", async () => {
    const service = serviceWith({ answer: new CloseFailure("unbalanced") });
    expect(await service.closePeriod(reader, { period: 202710, run: RUN })).toEqual({ kind: "unbalanced" });
    expect(service.reported).toEqual(["close_unbalanced"]);
  });

  it("descargar: el archivo, o la respuesta de su lista", async () => {
    const service = serviceWith();
    expect(await service.downloadExport(reader, { run: RUN })).toEqual({ kind: "file", file: EXPORT });
    for (const outcome of ["not_found", "forbidden", "needs_fresh_code"]) {
      const refused = serviceWith({ download: { outcome } });
      expect(await refused.downloadExport(reader, { run: RUN })).toEqual({ kind: "answered", answer: outcome });
    }
  });
});

describe("givePeriodsCode", () => {
  it("verificado, y la lectura dice que el código es reciente: verified", async () => {
    const service = serviceWith();
    expect(await service.givePeriodsCode(jar, "123456")).toEqual({ kind: "verified" });
    expect(service.calls).toEqual(["guarda", "código", "guarda", "periodos"]);
  });

  it("verificado, y aun así no es reciente: es configuración, y se reporta", async () => {
    const service = serviceWith({ periods: { freshCode: false, periods: [] } });
    expect(await service.givePeriodsCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(service.reported).toEqual(["period_change_unavailable"]);
  });

  it("sin finanzas: refused, sin pedir el código", async () => {
    const service = serviceWith({ check: teamCheck(standingOf(["content"])) });
    expect(await service.givePeriodsCode(jar, "123456")).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("un código equivocado, el freno o no se supo: tal cual", async () => {
    for (const kind of ["wrong_code", "throttled", "unavailable"] as const) {
      const service = serviceWith({ code: { kind } as CodeGiven });
      expect(await service.givePeriodsCode(jar, "123456")).toEqual({ kind });
    }
  });

  it("perdió finanzas entre verificar y leer: decide la página", async () => {
    const service = serviceWith({ periods: null });
    expect(await service.givePeriodsCode(jar, "123456")).toEqual({ kind: "refused" });
  });
});
