import { describe, expect, it } from "vitest";

import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { EXCLUSION_REASONS, NOTE_MAX, REASON_MAX, type FinanceAlert, type FinanceAlerts } from "@/services/anomalies/anomalies";

import { alertsButton } from "./outcomes";
import { alertsView, percentText, periodText, REASON_LABELS, spanText } from "./rows";

// Lo que PA-68 mínima pinta, ya en palabras: qué se ofrece y qué se dice de cada alerta. Puro.

const text = admin.alerts;
const ALERT = "a1e70000-0000-4000-8000-000000000002";
const EXCLUSION = "e0000000-0000-4000-8000-000000000003";

const JUMP: FinanceAlert = {
  id: ALERT,
  period: 202610,
  kind: "teacher_points_jump",
  status: "open",
  metric: 6666.667,
  threshold: 5000,
  today: 7000,
  details: { before: 6, after: 10, students_before: 2, students_after: 3, floor: 4 },
  detectedAt: "2026-11-01T09:00:00Z",
  reviewNote: null,
  isFraud: null,
  evidence: null,
  reviewedAt: null,
  reviewedByName: null,
  teacherName: "Maestra Uno",
  canExclude: true,
  accounts: [
    { account: "0123456789ab", age: "under_7", share: "only", halfPoints: 4, halfPointsBefore: 0, lessons: 2, coveredSeconds: null, excluded: false },
    { account: "ba9876543210", age: "over_90", share: "less_than_half", halfPoints: 2, halfPointsBefore: 2, lessons: 1, coveredSeconds: null, excluded: true },
  ],
  moreAccounts: 3,
  exclusions: [
    {
      id: EXCLUSION,
      account: "ba9876543210",
      scope: "account",
      reasonCode: "test_account",
      reason: "Es de prueba.",
      createdByName: "Ana",
      createdAt: "2026-11-02T18:00:00Z",
      revokedAt: null,
      revokedByName: null,
      revokeReason: null,
    },
  ],
};

const IMPOSSIBLE: FinanceAlert = {
  ...JUMP,
  id: "a1e70000-0000-4000-8000-000000000009",
  kind: "impossible_completion",
  status: "reviewed",
  metric: 7_200,
  threshold: 3_600,
  today: null,
  details: { lessons: 5, covered_seconds: 14_400, speed: 2 },
  reviewNote: "Lo revisé.",
  isFraud: true,
  evidence: "Cinco lecciones en una hora.",
  reviewedAt: "2026-10-20T18:00:00Z",
  reviewedByName: null,
  teacherName: null,
  canExclude: false,
  accounts: [{ account: "0123456789ab", age: "under_30", share: null, halfPoints: null, halfPointsBefore: null, lessons: 5, coveredSeconds: 14_400, excluded: false }],
  moreAccounts: 0,
  exclusions: [
    {
      ...JUMP.exclusions[0]!,
      account: "0123456789ab",
      reasonCode: "fraud",
      createdByName: null,
      revokedAt: "2026-10-21T18:00:00Z",
      revokedByName: "Beto",
      revokeReason: "Era un error.",
    },
  ],
};

const read = (alerts: FinanceAlert[], over: Partial<FinanceAlerts> = {}): FinanceAlerts => ({ freshCode: true, total: alerts.length, alerts, ...over });

describe("las cifras en palabras", () => {
  it("el periodo, como mes y año", () => {
    expect(periodText(202610)).toBe("octubre de 2026");
    expect(periodText(202701)).toBe("enero de 2027");
    for (const bad of [202613, 202600, 2026, 202610.5]) expect(periodText(bad)).toBe("");
  });

  it("los puntos base, como porcentaje", () => {
    expect(percentText(5000)).toMatch(/^50\s?%$/);
    expect(percentText(6666.667)).toMatch(/^66\.7\s?%$/);
    expect(percentText(Number.NaN)).toBe("");
  });

  it("un tiempo largo, a minutos", () => {
    expect(spanText(7_200)).toBe(t(text.hoursMinutes, { hours: "2", minutes: "0" }));
    expect(spanText(43_500)).toBe(t(text.hoursMinutes, { hours: "12", minutes: "5" }));
    expect(spanText(2_400)).toBe(t(text.minutesOnly, { minutes: "40" }));
    expect(spanText(-1)).toBe("");
  });
});

describe("alertsView", () => {
  it("el salto de puntos: sus cifras, sus cuentas y lo que se ofrece", () => {
    const view = alertsView(read([JUMP]));
    expect(view.canChange).toBe(true);
    expect(view.more).toBeNull();
    const [card] = view.alerts;
    expect(card).toMatchObject({ id: ALERT, open: true, status: text.open, trigger: text.triggers.teacherPointsJump, reviewed: null, fraud: null });
    expect(card?.title).toBe(t(text.kinds.teacherPointsJump));
    expect(card?.period).toBe(t(text.period, { period: "octubre de 2026" }));
    expect(card?.facts).toEqual([
      t(text.teacher, { name: "Maestra Uno" }),
      t(text.jumpPoints, { before: "6", after: "10" }),
      t(text.jumpRise, { metric: percentText(6666.667), threshold: percentText(5000) }),
      t(text.jumpToday, { today: percentText(7000) }),
    ]);
    // Abierta: decidir fraude espera a la revisión, que es la que pide la nota.
    expect(card).toMatchObject({ canDecideFraud: false, fraudWaits: true });
    expect(card?.closed).toBeNull();
    expect(card?.accountsTitle).toBe(text.accountsTitle);
    expect(card?.moreAccounts).toBe(t(text.moreAccounts.other, { count: "3" }));
    expect(card?.buttons).toEqual({ review: alertsButton.review(ALERT), askFraud: alertsButton.askFraud(ALERT), fraud: alertsButton.fraud(ALERT) });
  });

  it("cada cuenta, por su huella y sus tramos; la excluida no se ofrece otra vez", () => {
    const [card] = alertsView(read([JUMP])).alerts;
    const [first, second] = card?.accounts ?? [];
    expect(first).toMatchObject({ account: "0123456789ab", title: t(text.account, { account: "0123456789ab" }), excluded: false, canExclude: true });
    expect(first?.facts).toEqual([
      { label: text.columns.age, value: text.ages.under7 },
      { label: text.columns.share, value: t(text.shares.only) },
      { label: text.columns.halfPoints, value: "4" },
      { label: text.columns.before, value: "0" },
      { label: text.columns.lessons, value: "2" },
    ]);
    expect(first?.confirmBody).toBe(t(text.confirmExcludeBody, { period: "octubre de 2026" }));
    expect(first?.buttons).toEqual({ ask: alertsButton.askExclusion(ALERT, "0123456789ab"), confirm: alertsButton.exclude(ALERT, "0123456789ab") });
    expect(second).toMatchObject({ excluded: true, canExclude: false });
  });

  it("sin fraude decidido, el motivo de fraude no se ofrece", () => {
    const [card] = alertsView(read([JUMP])).alerts;
    expect(card?.accounts[0]?.reasons.map((reason) => reason.value)).toEqual(["technical_error", "test_account", "other"]);
  });

  it("con fraude decidido, una cuenta excluida por otro motivo se puede excluir por fraude, y solo por eso", () => {
    const [card] = alertsView(read([{ ...JUMP, status: "reviewed", isFraud: true, evidence: "Once cuentas." }])).alerts;
    const [free, other] = card?.accounts ?? [];
    expect(free?.reasons.map((reason) => reason.value)).toEqual(["technical_error", "test_account", "other", "fraud"]);
    expect(other).toMatchObject({ excluded: true, canExclude: true });
    expect(other?.reasons.map((reason) => reason.value)).toEqual(["fraud"]);
  });

  it("excluida ya por fraude por esta alerta, no se ofrece otra vez", () => {
    const exclusions = [{ ...JUMP.exclusions[0]!, reasonCode: "fraud" as const }];
    const [card] = alertsView(read([{ ...JUMP, status: "reviewed", isFraud: true, evidence: "Once cuentas.", exclusions }])).alerts;
    expect(card?.accounts[1]).toMatchObject({ excluded: true, canExclude: false });
    // Una revertida no cuenta.
    const revoked = [{ ...exclusions[0]!, revokedAt: "2026-11-03T18:00:00Z" }];
    const [again] = alertsView(read([{ ...JUMP, status: "reviewed", isFraud: true, evidence: "Once cuentas.", exclusions: revoked }])).alerts;
    expect(again?.accounts[1]).toMatchObject({ canExclude: true });
  });

  it("una exclusión vigente con el periodo abierto se puede revertir", () => {
    const [card] = alertsView(read([JUMP])).alerts;
    expect(card?.exclusions).toEqual([
      {
        id: EXCLUSION,
        summary: t(text.exclusion, {
          account: "ba9876543210",
          scope: text.scopes.account,
          reason: text.reasons.testAccount,
          text: "Es de prueba.",
          name: "Ana",
          date: "2 de noviembre de 2026",
        }),
        revoked: null,
        canRevoke: true,
        buttons: { ask: alertsButton.askRevocation(ALERT, EXCLUSION), confirm: alertsButton.revoke(ALERT, EXCLUSION) },
      },
    ]);
  });

  it("lecciones imposibles, revisada, decidida como fraude y con el periodo cerrado", () => {
    const [card] = alertsView(read([IMPOSSIBLE])).alerts;
    expect(card).toMatchObject({ open: false, status: text.reviewed, canDecideFraud: false, fraudWaits: false, closed: text.closed, accountsTitle: text.accountTitle, moreAccounts: null });
    expect(card?.facts).toEqual([t(text.impossibleNeeded, { metric: spanText(7_200), threshold: spanText(3_600) })]);
    expect(card?.reviewed).toBe(t(text.reviewedBy, { date: "20 de octubre de 2026", name: text.someone }));
    expect(card?.note).toBe(t(text.note, { note: "Lo revisé." }));
    expect(card?.fraud).toBe(`${text.fraudDecided} ${t(text.evidence, { evidence: "Cinco lecciones en una hora." })}`);
    expect(card?.accounts[0]?.reasons.map((reason) => reason.value)).toEqual(["technical_error", "test_account", "other", "fraud"]);
    expect(card?.accounts[0]).toMatchObject({ canExclude: false });
    expect(card?.accounts[0]?.facts).toEqual([
      { label: text.columns.age, value: text.ages.under30 },
      { label: text.columns.lessons, value: "5" },
      { label: text.columns.covered, value: spanText(14_400) },
    ]);
    expect(card?.exclusions[0]).toMatchObject({
      canRevoke: false,
      revoked: t(text.revokedBy, { date: "21 de octubre de 2026", name: "Beto", text: "Era un error." }),
    });
    expect(card?.exclusions[0]?.summary).toContain(text.someone);
  });

  it("con el periodo cerrado, una exclusión vigente no se ofrece revertir", () => {
    const [card] = alertsView(read([{ ...JUMP, canExclude: false }])).alerts;
    expect(card?.exclusions[0]).toMatchObject({ revoked: null, canRevoke: false });
  });

  it("decidida como «no es fraude», todavía se puede decidir que sí: la base solo impide deshacer el fraude", () => {
    const [card] = alertsView(read([{ ...JUMP, status: "reviewed", isFraud: false }])).alerts;
    expect(card).toMatchObject({ canDecideFraud: true, fraudWaits: false, fraud: null });
    expect(card?.accounts[0]?.reasons.map((reason) => reason.value)).not.toContain("fraud");
  });

  it("la cifra de hoy de lecciones imposibles, si se pudo recalcular", () => {
    const [card] = alertsView(read([{ ...IMPOSSIBLE, today: 9_000 }])).alerts;
    expect(card?.facts.at(-1)).toBe(t(text.impossibleToday, { today: spanText(9_000) }));
  });

  it("los topes de los textos son los de la base", () => {
    expect(alertsView(read([JUMP])).limits).toEqual({ note: NOTE_MAX, reason: REASON_MAX });
  });

  it("sin código reciente, y con alertas que no caben", () => {
    const view = alertsView(read([JUMP], { freshCode: false, total: 52 }));
    expect(view.canChange).toBe(false);
    expect(view.more).toBe(t(text.moreAlerts.other, { count: "51" }));
    expect(alertsView(read([JUMP], { total: 2 })).more).toBe(t(text.moreAlerts.one, { count: "1" }));
  });

  it("los motivos son los de la base, todos con su texto", () => {
    expect(Object.keys(REASON_LABELS)).toEqual([...EXCLUSION_REASONS]);
  });
});
