import { describe, expect, it } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

import { createPayoutReports, periodFromSegment, periodSegment, type PayoutReportStore } from "./payout-report";

// El servicio del reporte del maestro (T-604, cuarta solicitud), con la base simulada: el periodo de la dirección, la sesión del CSV y «no se supo». Lo que
// la base decide lo prueba la 81, y el camino contra la base local, la integración 89.

const claims = { sub: "a0000000-0000-4000-8000-000000000001" } as unknown as VerifiedClaims;
const reader = {} as CookieReader;

function harness(change: { store?: Partial<PayoutReportStore>; session?: SessionCheck } = {}) {
  const asked: number[] = [];
  const reported: FailureCode[] = [];
  const store: PayoutReportStore = {
    mine: () => Promise.resolve({ outcome: "ok", value: { balanceCents: null, periods: [] } }),
    report: (_c, period) => {
      asked.push(period);
      return Promise.resolve({ outcome: "not_found" });
    },
    csv: (_c, period) => {
      asked.push(period);
      return Promise.resolve({ outcome: "ok", csv: "﻿\"Alumno\",\"Puntos\",\"Pesos\"\r\n" });
    },
    ...change.store,
  };
  const service = createPayoutReports({
    store,
    checkSession: () => Promise.resolve(change.session ?? ({ kind: "pass", claims } as unknown as SessionCheck)),
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
  return { service, asked, reported };
}

describe("el periodo de la dirección", () => {
  it.each([
    ["2031-02", 203102],
    ["2026-12", 202612],
  ])("%s es %d", (segment, period) => {
    expect(periodFromSegment(segment)).toBe(period);
    expect(periodSegment(period)).toBe(segment);
  });

  it.each(["2031-13", "2031-00", "2031-2", "203102", "1999-01", " 2031-02", "2031-02/", "", null, 203102])("%j no tiene forma", (segment) => {
    expect(periodFromSegment(segment)).toBeNull();
  });
});

describe("las lecturas", () => {
  it("un periodo sin forma no se le pregunta a la base", async () => {
    const { service, asked } = harness();
    expect(await service.payoutReport(claims, "2031-13")).toEqual({ kind: "ready", value: { outcome: "not_found" } });
    expect(asked).toEqual([]);
  });

  it("uno con forma, sí, como AAAAMM", async () => {
    const { service, asked } = harness();
    await service.payoutReport(claims, "2031-02");
    expect(asked).toEqual([203102]);
  });

  it("si la base no contesta, «no se supo», y se reporta", async () => {
    const { service, reported } = harness({ store: { mine: () => Promise.reject(new Error("caída")) } });
    expect(await service.myPayouts(claims)).toEqual({ kind: "unavailable" });
    expect(reported).toEqual(["payout_report_unavailable"]);
  });
});

describe("el CSV", () => {
  it("corre la guarda de sesión antes de todo", async () => {
    const refused = { kind: "anonymous" } as unknown as SessionCheck;
    const { service, asked } = harness({ session: refused });
    expect(await service.payoutReportCsv(reader, "2031-02")).toEqual({ kind: "session", check: refused });
    expect(asked).toEqual([]);
  });

  it("da el archivo con su nombre", async () => {
    const { service } = harness();
    expect(await service.payoutReportCsv(reader, "2031-02")).toEqual({
      kind: "csv", fileName: "reporte-2031-02.csv", text: "﻿\"Alumno\",\"Puntos\",\"Pesos\"\r\n",
    });
  });

  it("un periodo sin forma, o lo que no es texto, no existe", async () => {
    const { service, asked } = harness();
    expect(await service.payoutReportCsv(reader, ["2031-02"])).toEqual({ kind: "not_found" });
    expect(asked).toEqual([]);
  });

  it("lo que contesta la base pasa tal cual, y su caída es «no se supo»", async () => {
    expect(await harness({ store: { csv: () => Promise.resolve({ outcome: "not_teacher" }) } }).service.payoutReportCsv(reader, "2031-02")).toEqual({
      kind: "not_teacher",
    });
    const down = harness({ store: { csv: () => Promise.reject(new Error("caída")) } });
    expect(await down.service.payoutReportCsv(reader, "2031-02")).toEqual({ kind: "unavailable" });
    expect(down.reported).toEqual(["payout_report_unavailable"]);
  });
});
