import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, CodeGiven, TeamCheck, TeamStanding } from "@/services/account/team";

import { createAnomalyAlerts, NOTE_MAX, REASON_MAX, type AnomalyStore, type FinanceAlerts } from "./alerts";

// Las alertas y las decisiones de finanzas, con todo lo de fuera simulado: a quién se le pregunta
// qué, en qué orden, y qué se decide con cada respuesta. Contra la base de verdad, en
// `tests/integration/46-alertas.test.ts` y `supabase/tests/30_alertas_lectura.test.sql`.

const ME = "a0000000-0000-4000-8000-000000000001";
const ALERT = "a1e70000-0000-4000-8000-000000000002";
const EXCLUSION = "e0000000-0000-4000-8000-000000000003";
const ACCOUNT = "0123456789ab";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const ALERTS: FinanceAlerts = { freshCode: true, total: 0, alerts: [] };

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["finance"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function serviceWith(
  setup: {
    check?: TeamCheck | TeamCheck[];
    alerts?: FinanceAlerts | null | "throws";
    answer?: string | "throws";
    code?: CodeGiven;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const checks = Array.isArray(setup.check) ? [...setup.check] : null;
  const answer = () => {
    if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
    return Promise.resolve((setup.answer ?? "reviewed") as never);
  };
  const store: AnomalyStore = {
    alerts: vi.fn(() => {
      calls.push("alertas");
      if (setup.alerts === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.alerts === undefined ? ALERTS : setup.alerts);
    }),
    review: vi.fn((_claims, alert: string, note: string | null, isFraud: boolean | null, evidence: string | null) => {
      calls.push(`revisar ${alert} ${note} ${isFraud} ${evidence}`);
      return answer();
    }),
    exclude: vi.fn((_claims, alert: string, account: string, reason: string) => {
      calls.push(`excluir ${alert} ${account} ${reason}`);
      return answer();
    }),
    revoke: vi.fn((_claims, exclusion: string) => {
      calls.push(`revertir ${exclusion}`);
      return answer();
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
  const service = createAnomalyAlerts(
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

describe("anomalyAlerts", () => {
  it("lee con las claims que la guarda dio, sin volver a correrla", async () => {
    const service = serviceWith();
    expect(await service.anomalyAlerts(reader, claims)).toEqual({ kind: "alerts", alerts: ALERTS });
    expect(service.calls).toEqual(["alertas"]);
  });

  it("nula, y la guarda ya no la deja pasar con finanzas: no se supo, sin reportar", async () => {
    const service = serviceWith({ alerts: null, check: teamCheck(standingOf(["content"])) });
    expect(await service.anomalyAlerts(reader, claims)).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["alertas", "guarda"]);
    expect(service.reported).toEqual([]);
  });

  it("nula, y la guarda insiste en que pasa: se reporta", async () => {
    const service = serviceWith({ alerts: null });
    expect(await service.anomalyAlerts(reader, claims)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["anomaly_alerts_unavailable"]);
  });

  it("si la lectura lanza, se reporta", async () => {
    const service = serviceWith({ alerts: "throws" });
    expect(await service.anomalyAlerts(reader, claims)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["anomaly_alerts_unavailable"]);
  });
});

describe("las decisiones: la guarda primero", () => {
  const decisions = [
    ["reviewAlert", (s: ReturnType<typeof serviceWith>) => s.reviewAlert(reader, { alert: ALERT, note: "Nota." })],
    ["decideFraud", (s: ReturnType<typeof serviceWith>) => s.decideFraud(reader, { alert: ALERT, evidence: "Evidencia." })],
    ["excludeAccount", (s: ReturnType<typeof serviceWith>) => s.excludeAccount(reader, { alert: ALERT, account: ACCOUNT, reasonCode: "other", reason: "Un motivo." })],
    ["revokeExclusion", (s: ReturnType<typeof serviceWith>) => s.revokeExclusion(reader, { exclusion: EXCLUSION, reason: "Un motivo." })],
  ] as const;

  it.each(decisions)("%s: sin finanzas, refused, sin preguntarle a la base", async (_name, call) => {
    const service = serviceWith({ check: teamCheck(standingOf(["content", "support"])) });
    expect(await call(service)).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each(decisions)("%s: sin saber quién pide, unavailable", async (_name, call) => {
    const service = serviceWith({ check: { kind: "unavailable" } as TeamCheck });
    expect(await call(service)).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each(decisions)("%s: si la base no contesta algo de su lista, unknown y se reporta", async (_name, call) => {
    const service = serviceWith({ answer: "throws" });
    expect(await call(service)).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["anomaly_decision_unavailable"]);
  });
});

describe("lo que llega se revisa antes de la base", () => {
  it("revisar: sin nota, o una nota de más, no llega", async () => {
    for (const note of ["", "   ", 7, "x".repeat(NOTE_MAX + 1)]) {
      const service = serviceWith();
      expect(await service.reviewAlert(reader, { alert: ALERT, note })).toEqual({ kind: "malformed" });
      expect(service.calls).toEqual(["guarda"]);
    }
  });

  it("revisar: manda la nota sin los espacios de las puntas, sin decidir fraude", async () => {
    const service = serviceWith();
    expect(await service.reviewAlert(reader, { alert: ALERT, note: "  La revisé.  " })).toEqual({ kind: "answered", answer: "reviewed" });
    expect(service.calls).toEqual(["guarda", `revisar ${ALERT} La revisé. null null`]);
  });

  it("decidir fraude: con la evidencia, sin nota", async () => {
    const service = serviceWith({ answer: "marked_fraud" });
    expect(await service.decideFraud(reader, { alert: ALERT, evidence: " Once cuentas. " })).toEqual({ kind: "answered", answer: "marked_fraud" });
    expect(service.calls).toEqual(["guarda", `revisar ${ALERT} null true Once cuentas.`]);
  });

  it("decidir fraude: sin evidencia no llega", async () => {
    const service = serviceWith();
    expect(await service.decideFraud(reader, { alert: ALERT, evidence: " " })).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("una alerta sin forma de identificador no llega", async () => {
    const service = serviceWith();
    expect(await service.reviewAlert(reader, { alert: ALERT.toUpperCase(), note: "Nota." })).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("excluir: la cuenta es una huella de doce caracteres, el motivo de la lista y escrito", async () => {
    const malformed = [
      { account: "0123456789AB", reasonCode: "other", reason: "Un motivo." },
      { account: "0123456789a", reasonCode: "other", reason: "Un motivo." },
      { account: ACCOUNT, reasonCode: "otro", reason: "Un motivo." },
      { account: ACCOUNT, reasonCode: "other", reason: "" },
      { account: ACCOUNT, reasonCode: "other", reason: "x".repeat(REASON_MAX + 1) },
    ];
    for (const input of malformed) {
      const service = serviceWith();
      expect(await service.excludeAccount(reader, { alert: ALERT, ...input })).toEqual({ kind: "malformed" });
      expect(service.calls).toEqual(["guarda"]);
    }
    const service = serviceWith({ answer: "excluded" });
    expect(await service.excludeAccount(reader, { alert: ALERT, account: ACCOUNT, reasonCode: "fraud", reason: "Un motivo." })).toEqual({
      kind: "answered",
      answer: "excluded",
    });
    expect(service.calls).toEqual(["guarda", `excluir ${ALERT} ${ACCOUNT} fraud`]);
  });

  it("revertir: una exclusión con forma y un motivo escrito", async () => {
    const bad = serviceWith();
    expect(await bad.revokeExclusion(reader, { exclusion: "no", reason: "Un motivo." })).toEqual({ kind: "malformed" });
    const service = serviceWith({ answer: "revoked" });
    expect(await service.revokeExclusion(reader, { exclusion: EXCLUSION, reason: "Era un error." })).toEqual({ kind: "answered", answer: "revoked" });
    expect(service.calls).toEqual(["guarda", `revertir ${EXCLUSION}`]);
  });
});

describe("giveFinanceCode", () => {
  it("verificado, y la lectura dice que el código es reciente: verified", async () => {
    const service = serviceWith();
    expect(await service.giveFinanceCode(jar, "123456")).toEqual({ kind: "verified" });
    expect(service.calls).toEqual(["guarda", "código", "guarda", "alertas"]);
  });

  it("verificado, y aun así no es reciente: es configuración, y se reporta", async () => {
    const service = serviceWith({ alerts: { ...ALERTS, freshCode: false } });
    expect(await service.giveFinanceCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(service.reported).toEqual(["anomaly_decision_unavailable"]);
  });

  it("sin finanzas: refused, sin pedir el código", async () => {
    const service = serviceWith({ check: teamCheck(standingOf(["config"])) });
    expect(await service.giveFinanceCode(jar, "123456")).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("un código equivocado, el freno o no se supo: tal cual", async () => {
    for (const kind of ["wrong_code", "throttled", "unavailable"] as const) {
      const service = serviceWith({ code: { kind } as CodeGiven });
      expect(await service.giveFinanceCode(jar, "123456")).toEqual({ kind });
    }
  });

  it("perdió finanzas entre verificar y leer: decide la página", async () => {
    const service = serviceWith({ check: [teamCheck(), teamCheck(standingOf(["content"]))] });
    expect(await service.giveFinanceCode(jar, "123456")).toEqual({ kind: "refused" });
  });
});
