import { describe, expect, it } from "vitest";

import { alertsOf, excludeAnswerOf, reviewAnswerOf, revokeAnswerOf } from "./records";

// Lo que se acepta de la base para PA-68: la forma exacta, y nada más. Un campo que este código no
// conoce (un identificador de una persona que alguien agregue a la función) hace fallar la lectura
// en vez de llegar a la pantalla.

const ALERT = {
  id: "a1e70000-0000-4000-8000-000000000002",
  period: 202610,
  kind: "teacher_points_jump",
  status: "open",
  metric: 6666.667,
  threshold: 5000,
  today: 7000,
  details: { before: 6, after: 10 },
  detected_at: "2026-10-22T09:00:00+00:00",
  review_note: null,
  is_fraud: null,
  evidence: null,
  reviewed_at: null,
  reviewed_by_name: null,
  teacher_name: "Maestra",
  can_exclude: true,
  accounts: [
    {
      account: "0123456789ab",
      age: "under_7",
      share: "only",
      half_points: 4,
      half_points_before: 0,
      lessons: 2,
      covered_seconds: null,
      excluded: false,
    },
  ],
  more_accounts: 0,
  exclusions: [],
};

describe("alertsOf", () => {
  it("lee la forma de la base", () => {
    const read = alertsOf({ fresh_code: true, total: 1, alerts: [ALERT] });
    expect(read?.alerts[0]).toMatchObject({ kind: "teacher_points_jump", teacherName: "Maestra", canExclude: true });
    expect(read?.alerts[0]?.accounts[0]).toEqual({
      account: "0123456789ab",
      age: "under_7",
      share: "only",
      halfPoints: 4,
      halfPointsBefore: 0,
      lessons: 2,
      coveredSeconds: null,
      excluded: false,
    });
  });

  it("nula: nulo", () => {
    expect(alertsOf(null)).toBeNull();
  });

  it("un campo de más en una cuenta no pasa", () => {
    const account = { ...ALERT.accounts[0], profile_id: "a0000000-0000-4000-8000-000000000001" };
    expect(() => alertsOf({ fresh_code: true, total: 1, alerts: [{ ...ALERT, accounts: [account] }] })).toThrow();
  });

  it("ni en la alerta, ni en la respuesta", () => {
    expect(() => alertsOf({ fresh_code: true, total: 1, alerts: [{ ...ALERT, profile_id: "x" }] })).toThrow();
    expect(() => alertsOf({ fresh_code: true, total: 1, alerts: [], email: "x" })).toThrow();
  });

  it("una cuenta que no tiene forma de huella no pasa", () => {
    const account = { ...ALERT.accounts[0], account: "a0000000-0000-4000-8000-000000000001" };
    expect(() => alertsOf({ fresh_code: true, total: 1, alerts: [{ ...ALERT, accounts: [account] }] })).toThrow();
  });
});

describe("las respuestas", () => {
  it("las de su lista pasan; otra lanza", () => {
    expect(reviewAnswerOf("marked_fraud")).toBe("marked_fraud");
    expect(excludeAnswerOf("already_excluded")).toBe("already_excluded");
    expect(revokeAnswerOf("already_revoked")).toBe("already_revoked");
    expect(() => reviewAnswerOf("excluded")).toThrow();
    expect(() => excludeAnswerOf(null)).toThrow();
    expect(() => revokeAnswerOf("revoked ")).toThrow();
  });
});
