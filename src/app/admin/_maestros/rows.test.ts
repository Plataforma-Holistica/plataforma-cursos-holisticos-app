import { describe, expect, it } from "vitest";

import { teacherVersion, type FraudRequest, type TeacherRoster, type TeacherRow } from "@/services/teachers/admin";

import { teachersButton } from "./outcomes";
import { rosterView, teacherView } from "./rows";

const TEACHER = "b0000000-0000-4000-8000-000000000002";
const REQUEST = "c0000000-0000-4000-8000-000000000004";

const ROW: TeacherRow = {
  id: TEACHER,
  name: "Ana",
  status: "active",
  founderSince: null,
  email: "ana@prueba.test",
  invitation: "accepted",
  expiresAt: null,
  suspension: null,
  suspendedAt: null,
  suspensionReason: null,
  suspensionNotice: null,
  fraudPending: false,
  isSelf: false,
};
const FRAUD: FraudRequest = {
  id: REQUEST,
  teacherId: TEACHER,
  name: "Ana",
  reason: "Puntos inflados",
  proposedAt: "2026-10-30T12:00:00Z",
  proposedBySelf: false,
  markedBySelf: false,
  aboutSelf: false,
  period: 202610,
  metric: 500,
  threshold: 300,
};
const rosterOf = (row: TeacherRow, requests: FraudRequest[] = []): TeacherRoster => ({ freshCode: true, teachers: [row], requests });

describe("PA-65: qué se ofrece de una invitación", () => {
  it.each([
    ["pending", true, true],
    ["expired", true, true],
    // Una revocada se reenvía, pero ya no se revoca.
    ["revoked", true, false],
    ["none", false, false],
  ] as const)("invitación %s: ¿reenviar? %s, ¿revocar? %s", (invitation, reinvite, revoke) => {
    const [row] = rosterView(rosterOf({ ...ROW, status: "invited", invitation })).rows;
    expect(row?.reinvite !== null).toBe(reinvite);
    expect(row?.revoke !== null).toBe(revoke);
  });

  it("a un maestro activo no se le ofrece nada de su invitación", () => {
    const [row] = rosterView(rosterOf(ROW)).rows;
    expect(row?.reinvite).toBeNull();
    expect(row?.revoke).toBeNull();
  });

  it("sobre la invitación propia no se ofrece nada", () => {
    const [row] = rosterView(rosterOf({ ...ROW, status: "invited", invitation: "pending", isSelf: true })).rows;
    expect(row?.reinvite).toBeNull();
    expect(row?.revoke).toBeNull();
    expect(row?.isSelf).toBe(true);
  });

  it("los botones llevan lo que se vio", () => {
    const seen: TeacherRow = { ...ROW, status: "invited", invitation: "expired" };
    const [row] = rosterView(rosterOf(seen)).rows;
    expect(row?.reinvite).toBe(teachersButton.reinvite(TEACHER, teacherVersion(seen)));
  });

  it("dice si la lectura trae el código reciente", () => {
    expect(rosterView({ ...rosterOf(ROW), freshCode: false }).canChange).toBe(false);
  });

  it("la cola enlaza a la ficha", () => {
    expect(rosterView(rosterOf(ROW, [FRAUD])).requests[0]?.teacherHref).toBe(`/admin/maestros/${TEACHER}`);
  });
});

describe("PA-66: la ficha", () => {
  it("un maestro que no está en la lista no tiene ficha", () => {
    expect(teacherView(rosterOf(ROW), REQUEST)).toBeNull();
  });

  it.each([
    ["active", true, false],
    ["suspended", false, true],
    ["invited", false, false],
    ["left", false, false],
  ] as const)("%s: ¿suspender? %s, ¿levantar? %s", (status, suspend, lift) => {
    const view = teacherView(rosterOf({ ...ROW, status }), TEACHER);
    expect(view?.suspend !== null).toBe(suspend);
    expect(view?.lift !== null).toBe(lift);
  });

  it("sobre sí no se ofrece ni el fundador, ni suspender, ni levantar", () => {
    const view = teacherView(rosterOf({ ...ROW, isSelf: true }), TEACHER);
    expect(view?.founder).toBeNull();
    expect(view?.suspend).toBeNull();
    expect(view?.lift).toBeNull();
    const suspended = teacherView(rosterOf({ ...ROW, status: "suspended", isSelf: true }), TEACHER);
    expect(suspended?.lift).toBeNull();
  });

  it("quitar el fundador solo se ofrece si lo es", () => {
    expect(teacherView(rosterOf(ROW), TEACHER)?.founder?.clear).toBeNull();
    expect(teacherView(rosterOf({ ...ROW, founderSince: "2026-11-01" }), TEACHER)?.founder?.clear).not.toBeNull();
  });

  it("la suspensión muestra el motivo y lo que lee el maestro, y distingue la de fraude", () => {
    const manual = teacherView(rosterOf({ ...ROW, status: "suspended", suspension: "manual", suspensionReason: "Motivo", suspensionNotice: "Aviso" }), TEACHER);
    const fraud = teacherView(rosterOf({ ...ROW, status: "suspended", suspension: "fraud" }), TEACHER);
    expect(manual?.suspension?.reason).toBe("Motivo");
    expect(manual?.suspension?.notice).toBe("Aviso");
    expect(manual?.suspension?.kind).not.toBe(fraud?.suspension?.kind);
  });

  it("sin propuesta no hay nada que decidir", () => {
    expect(teacherView(rosterOf(ROW), TEACHER)?.request).toBeNull();
  });

  it("con una propuesta, otra persona la confirma o la rechaza, con lo que se vio", () => {
    const row = { ...ROW, fraudPending: true };
    const view = teacherView(rosterOf(row, [FRAUD]), TEACHER);
    expect(view?.request?.blocked).toBeNull();
    expect(view?.request?.confirm).toBe(teachersButton.confirm(TEACHER, teacherVersion(row), REQUEST));
    expect(view?.request?.reject).toBe(teachersButton.reject(TEACHER, teacherVersion(row), REQUEST));
  });

  it.each([
    ["quien la propuso", { proposedBySelf: true }],
    ["quien marcó la alerta", { markedBySelf: true }],
    ["el maestro mismo", { aboutSelf: true }],
  ])("a %s no se le ofrece decidir, y la pantalla dice por qué", (_who, extra) => {
    const view = teacherView(rosterOf({ ...ROW, fraudPending: true }, [{ ...FRAUD, ...extra }]), TEACHER);
    expect(view?.request?.blocked).not.toBeNull();
    expect(view?.request?.ask).toBeNull();
    expect(view?.request?.confirm).toBeNull();
    expect(view?.request?.reject).toBeNull();
  });
});
