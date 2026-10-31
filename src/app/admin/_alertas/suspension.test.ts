import { describe, expect, it } from "vitest";

import { PROPOSE_ANSWERS, WITHDRAW_ANSWERS } from "@/services/anomalies/alerts";

import { alertsButton, askedBy, proposeOutcome, readAlertsForm, withdrawOutcome } from "./outcomes";

// Proponer y retirar la suspensión por fraude en PA-68 (T-401, FL-64): lo que llega y lo que hace con cada respuesta.

const ALERT = "a0000000-0000-4000-8000-000000000001";
const REQUEST = "c0000000-0000-4000-8000-000000000004";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("lo que llega", () => {
  it("proponer y preguntar llevan la alerta del botón", () => {
    expect(readAlertsForm(form({ do: alertsButton.askProposal(ALERT) }))).toMatchObject({ step: "ask_propose", alert: ALERT });
    expect(readAlertsForm(form({ do: alertsButton.propose(ALERT), reason: "Motivo" }))).toMatchObject({ step: "propose", alert: ALERT, drafts: { reason: "Motivo" } });
  });

  it("retirar lleva la propuesta del botón", () => {
    expect(readAlertsForm(form({ do: alertsButton.withdraw(ALERT, REQUEST) }))).toMatchObject({ step: "withdraw", alert: ALERT, request: REQUEST });
  });

  it("un retirar sin forma cuenta como vacío", () => {
    expect(readAlertsForm(form({ do: "withdraw:" + ALERT + ":x" }))).toEqual({ step: "none" });
    expect(readAlertsForm(form({ do: "withdraw:" + ALERT }))).toEqual({ step: "none" });
  });
});

describe("preguntar", () => {
  it("el primer paso pregunta sin llamar a nadie", () => {
    expect(askedBy({ step: "ask_propose", alert: ALERT, drafts: {} })).toEqual({ confirming: { step: "propose", alert: ALERT }, problem: null });
  });

  it("confirmar sin el motivo vuelve a preguntar", () => {
    expect(askedBy({ step: "propose", alert: ALERT, drafts: { reason: " " } })).toEqual({ confirming: { step: "propose", alert: ALERT }, problem: "missing_reason" });
    expect(askedBy({ step: "propose", alert: ALERT, drafts: { reason: "Motivo" } })).toBeNull();
  });

  it("retirar no pregunta: se puede volver a proponer", () => {
    expect(askedBy({ step: "withdraw", alert: ALERT, request: REQUEST, drafts: {} })).toBeNull();
  });
});

describe("lo que hace con cada respuesta", () => {
  it.each(PROPOSE_ANSWERS)("proponer: %s tiene su caso", (answer) => expect(proposeOutcome({ kind: "answered", answer })).toBeDefined());
  it.each(WITHDRAW_ANSWERS)("retirar: %s tiene su caso", (answer) => expect(withdrawOutcome({ kind: "answered", answer })).toBeDefined());

  it.each([
    ["proposed", { kind: "leave", to: "/admin/alertas", notice: "fraud_proposed" }],
    ["self", { kind: "failed", reason: "self" }],
    ["already_pending", { kind: "failed", reason: "already_pending" }],
    ["already_suspended", { kind: "failed", reason: "already_suspended" }],
    ["not_active", { kind: "failed", reason: "not_active" }],
    ["alert_used", { kind: "failed", reason: "alert_used" }],
    ["needs_fraud_decision", { kind: "failed", reason: "needs_fraud_decision" }],
    ["invalid", { kind: "failed", reason: "missing_reason" }],
    ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
    ["forbidden", { kind: "leave", to: "/admin/alertas", notice: null }],
  ] as const)("proponer con %s", (answer, expected) => {
    expect(proposeOutcome({ kind: "answered", answer })).toEqual(expected);
  });

  it.each([
    ["withdrawn", { kind: "leave", to: "/admin/alertas", notice: "fraud_withdrawn" }],
    ["not_yours", { kind: "failed", reason: "not_yours" }],
    ["not_found", { kind: "failed", reason: "not_found" }],
  ] as const)("retirar con %s", (answer, expected) => {
    expect(withdrawOutcome({ kind: "answered", answer })).toEqual(expected);
  });

  it.each([
    [{ kind: "refused" as const }, { kind: "leave", to: "/admin/alertas", notice: null }],
    [{ kind: "unavailable" as const }, { kind: "failed", reason: "unavailable" }],
    [{ kind: "unknown" as const }, { kind: "failed", reason: "unknown" }],
  ])("%j", (result, expected) => {
    expect(proposeOutcome(result)).toEqual(expected);
    expect(withdrawOutcome(result)).toEqual(expected);
  });
});
