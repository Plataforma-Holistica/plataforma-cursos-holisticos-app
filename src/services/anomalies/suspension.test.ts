import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { TeamCheck } from "@/services/account/team";

import { createAnomalyAlerts, PROPOSE_ANSWERS, WITHDRAW_ANSWERS, type AnomalyStore } from "./alerts";
import { suspensionsOf } from "./records";

// Proponer y retirar la suspensión de un maestro por fraude desde PA-68 (T-401, FL-64). Contra la base de verdad se prueba
// en tests/integration/82-administrar-maestros.test.ts.

const ALERT = "a0000000-0000-4000-8000-000000000001";
const REQUEST = "c0000000-0000-4000-8000-000000000004";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: "a0000000-0000-4000-8000-00000000000f", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const jar = { get: () => undefined, set: () => undefined };
const finance: TeamCheck = { kind: "team", claims, standing: { state: "member", capabilities: ["finance"], factor: BOUND }, inProgress: null };

function withAnswer(check: TeamCheck, answer: string | "throws" = "proposed") {
  const reported: string[] = [];
  const run = () => (answer === "throws" ? Promise.reject(new Error("sin base")) : Promise.resolve(answer));
  const store = { propose: vi.fn(run), withdraw: vi.fn(run) };
  const service = createAnomalyAlerts(
    {
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { teamStanding: () => Promise.resolve(check), giveSecondFactorCode: vi.fn(), store: store as unknown as AnomalyStore },
  );
  return { ...service, store, reported };
}

describe("proponer", () => {
  it("lleva la alerta y el motivo limpio", async () => {
    const service = withAnswer(finance);
    expect(await service.proposeSuspension(jar, { alert: ALERT, reason: " Puntos " })).toEqual({ kind: "answered", answer: "proposed" });
    expect(service.store.propose).toHaveBeenCalledExactlyOnceWith(claims, ALERT, "Puntos");
  });

  it.each([
    [{ alert: "x", reason: "r" }],
    [{ alert: ALERT, reason: " " }],
    [{ alert: ALERT, reason: "r".repeat(4_001) }],
  ])("sin forma no llega: %j", async (input) => {
    const service = withAnswer(finance);
    expect(await service.proposeSuspension(jar, input)).toEqual({ kind: "malformed" });
    expect(service.store.propose).not.toHaveBeenCalled();
  });

  it("sin finanzas contesta refused, sin preguntar", async () => {
    const service = withAnswer({ ...finance, standing: { state: "member", capabilities: ["content"], factor: BOUND } } as TeamCheck);
    expect(await service.proposeSuspension(jar, { alert: ALERT, reason: "r" })).toEqual({ kind: "refused" });
    expect(service.store.propose).not.toHaveBeenCalled();
  });

  it("si la base falla, unknown, y queda dicho", async () => {
    const service = withAnswer(finance, "throws");
    expect(await service.proposeSuspension(jar, { alert: ALERT, reason: "r" })).toEqual({ kind: "unknown" });
    expect(service.reported).toHaveLength(1);
  });
});

describe("retirar", () => {
  it("lleva la propuesta", async () => {
    const service = withAnswer(finance, "withdrawn");
    expect(await service.withdrawSuspension(jar, { request: REQUEST })).toEqual({ kind: "answered", answer: "withdrawn" });
    expect(service.store.withdraw).toHaveBeenCalledExactlyOnceWith(claims, REQUEST);
  });

  it("sin forma no llega", async () => {
    const service = withAnswer(finance);
    expect(await service.withdrawSuspension(jar, { request: "x" })).toEqual({ kind: "malformed" });
    expect(service.store.withdraw).not.toHaveBeenCalled();
  });
});

describe("las listas cerradas", () => {
  it("dicen lo que contestan las funciones de la base", () => {
    expect([...PROPOSE_ANSWERS].sort()).toEqual(
      ["alert_used", "already_pending", "already_suspended", "forbidden", "invalid", "needs_fraud_decision", "needs_fresh_code", "not_active", "proposed", "self"].sort(),
    );
    expect([...WITHDRAW_ANSWERS].sort()).toEqual(["forbidden", "needs_fresh_code", "not_found", "not_yours", "withdrawn"].sort());
  });
});

describe("la propuesta de cada alerta", () => {
  it("sale de la cola, por alerta", () => {
    const row = {
      request_id: REQUEST,
      alert_id: ALERT,
      teacher_id: ALERT,
      display_name: null,
      teacher_status: "active",
      reason: "r",
      proposed_at: "2026-10-30",
      proposed_by_self: true,
      marked_by_self: false,
      about_self: false,
      alert_period: 202610,
      alert_metric: 1,
      alert_threshold: 1,
    };
    expect(suspensionsOf({ requests: [row] }).get(ALERT)).toEqual({ id: REQUEST, mine: true });
  });

  it("sin cola (quien lee no pasa su puerta), ninguna", () => {
    expect(suspensionsOf(null).size).toBe(0);
  });
});
