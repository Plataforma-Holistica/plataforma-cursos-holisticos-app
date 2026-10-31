import { describe, expect, it } from "vitest";

import {
  DECIDE_ANSWERS,
  FOUNDER_ANSWERS,
  INVITE_ANSWERS,
  LIFT_ANSWERS,
  REINVITE_ANSWERS,
  REVOKE_ANSWERS,
  SUSPEND_ANSWERS,
} from "@/services/teachers/admin";

import {
  decideOutcome,
  founderOutcome,
  inviteOutcome,
  liftOutcome,
  problemsOf,
  readTeachersForm,
  reinviteOutcome,
  revokeOutcome,
  suspendOutcome,
  teachersButton,
} from "./outcomes";

const TEACHER = "b0000000-0000-4000-8000-000000000002";
const REQUEST = "c0000000-0000-4000-8000-000000000004";
const SEEN = "active.-.accepted.-.0";
const PAGE = `/admin/maestros/${TEACHER}`;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("lo que llega", () => {
  it("lo que no es un formulario, sin intención o con dos, cuenta como vacío", () => {
    expect(readTeachersForm("nada")).toEqual({ step: "none" });
    expect(readTeachersForm(form({}))).toEqual({ step: "none" });
    const twice = form({ do: "invite" });
    twice.append("do", "invite");
    expect(readTeachersForm(twice)).toEqual({ step: "none" });
    expect(readTeachersForm(form({ do: "x".repeat(300) }))).toEqual({ step: "none" });
  });

  it.each([
    "reinvite:no-es-un-id:" + SEEN,
    `reinvite:${TEACHER}`,
    `reinvite:${TEACHER}:${SEEN}:de-mas`,
    `borrar:${TEACHER}:${SEEN}`,
    `confirm:${TEACHER}:${SEEN}:no-es-un-id`,
    `confirm:${TEACHER}:${SEEN}`,
    `suspend:${TEACHER}:${SEEN}:de-mas`,
  ])("una intención sin forma cuenta como vacío: %s", (value) => {
    expect(readTeachersForm(form({ do: value }))).toEqual({ step: "none" });
  });

  it("cancelar", () => {
    expect(readTeachersForm(form({ do: "cancel" }))).toEqual({ step: "cancel" });
  });

  it("invitar: el nombre y el correo, tal como llegaron", () => {
    expect(readTeachersForm(form({ do: "invite", name: " Ana ", email: " ana@prueba.test " }))).toEqual({
      step: "invite",
      drafts: { name: " Ana ", email: " ana@prueba.test " },
    });
  });

  it.each([
    [teachersButton.reinvite(TEACHER, SEEN), "reinvite"],
    [teachersButton.revoke(TEACHER, SEEN), "revoke"],
    [teachersButton.lift(TEACHER, SEEN), "lift"],
    [teachersButton.clearFounder(TEACHER, SEEN), "clear_founder"],
  ])("%s: de quién y lo que se vio salen del botón", (value, step) => {
    expect(readTeachersForm(form({ do: value, teacher: "otro" }))).toEqual({ step, teacher: TEACHER, seen: SEEN, drafts: {} });
  });

  it("fundador: el día escrito", () => {
    expect(readTeachersForm(form({ do: teachersButton.founder(TEACHER, SEEN), since: "2026-11-01" }))).toEqual({
      step: "founder",
      teacher: TEACHER,
      seen: SEEN,
      drafts: { since: "2026-11-01" },
    });
  });

  it.each([
    [teachersButton.askSuspend(TEACHER, SEEN), "ask_suspend"],
    [teachersButton.suspend(TEACHER, SEEN), "suspend"],
  ])("%s: el motivo y el texto para el maestro", (value, step) => {
    expect(readTeachersForm(form({ do: value, reason: "Motivo", notice: "Aviso" }))).toEqual({
      step,
      teacher: TEACHER,
      seen: SEEN,
      drafts: { reason: "Motivo", notice: "Aviso" },
    });
  });

  it.each([
    [teachersButton.askConfirm(TEACHER, SEEN, REQUEST), "ask_confirm"],
    [teachersButton.confirm(TEACHER, SEEN, REQUEST), "confirm"],
    [teachersButton.reject(TEACHER, SEEN, REQUEST), "reject"],
  ])("%s: la propuesta sale del botón", (value, step) => {
    expect(readTeachersForm(form({ do: value, note: "Nota", notice: "Aviso" }))).toEqual({
      step,
      teacher: TEACHER,
      seen: SEEN,
      request: REQUEST,
      drafts: { note: "Nota", notice: "Aviso" },
    });
  });

  it("un texto desmedido llega cortado, un poco más que el tope: la regla lo rechaza", () => {
    const read = readTeachersForm(form({ do: teachersButton.suspend(TEACHER, SEEN), reason: "r".repeat(9_000), notice: "n" }));
    expect(read.step === "suspend" && (read.drafts.reason ?? "").length).toBeLessThan(5_000);
  });
});

describe("lo que falta se dice sin llamar a nadie", () => {
  it.each([
    [{ name: "", email: "ana@prueba.test" }, ["name"]],
    [{ name: "Ana", email: "" }, ["email"]],
    [{ name: "Ana", email: "sin-arroba" }, ["email"]],
    [{ name: "x".repeat(81), email: "ana@prueba.test" }, ["name"]],
    [{ name: "Ana", email: "ana@prueba.test" }, []],
  ])("invitar con %j", (drafts, expected) => {
    expect(problemsOf({ step: "invite", drafts })).toEqual(expected);
  });

  it.each([
    [{ reason: "", notice: "" }, ["reason", "notice"]],
    [{ reason: "r".repeat(1_001), notice: "n" }, ["reason"]],
    [{ reason: "r", notice: "n".repeat(301) }, ["notice"]],
    [{ reason: "r", notice: "n" }, []],
  ])("suspender con %j", (drafts, expected) => {
    expect(problemsOf({ step: "suspend", teacher: TEACHER, seen: SEEN, drafts })).toEqual(expected);
  });

  it("confirmar pide el texto para el maestro; rechazar no", () => {
    expect(problemsOf({ step: "confirm", teacher: TEACHER, seen: SEEN, request: REQUEST, drafts: { notice: " " } })).toEqual(["notice"]);
    expect(problemsOf({ step: "reject", teacher: TEACHER, seen: SEEN, request: REQUEST, drafts: {} })).toEqual([]);
  });

  it("fundador pide el día", () => {
    expect(problemsOf({ step: "founder", teacher: TEACHER, seen: SEEN, drafts: { since: "" } })).toEqual(["since"]);
    expect(problemsOf({ step: "founder", teacher: TEACHER, seen: SEEN, drafts: { since: "2026-02-30" } })).toEqual(["since"]);
    expect(problemsOf({ step: "founder", teacher: TEACHER, seen: SEEN, drafts: { since: "2026-11-01" } })).toEqual([]);
  });
});

describe("cada respuesta de la base tiene su caso", () => {
  const answered = <Answer,>(answer: Answer) => ({ kind: "answered" as const, answer });

  it.each(INVITE_ANSWERS)("invitar: %s", (answer) => expect(inviteOutcome(answered(answer))).toBeDefined());
  it.each(REINVITE_ANSWERS)("reenviar: %s", (answer) => expect(reinviteOutcome(answered(answer))).toBeDefined());
  it.each(REVOKE_ANSWERS)("revocar: %s", (answer) => expect(revokeOutcome(answered(answer))).toBeDefined());
  it.each(FOUNDER_ANSWERS)("fundador: %s", (answer) => expect(founderOutcome(answered(answer), PAGE)).toBeDefined());
  it.each(SUSPEND_ANSWERS)("suspender: %s", (answer) => expect(suspendOutcome(answered(answer), PAGE)).toBeDefined());
  it.each(LIFT_ANSWERS)("levantar: %s", (answer) => expect(liftOutcome(answered(answer), PAGE)).toBeDefined());
  it.each(DECIDE_ANSWERS)("decidir: %s", (answer) => expect(decideOutcome(answered(answer), PAGE)).toBeDefined());

  it.each([
    ["invited_new", { kind: "leave", to: "/admin/maestros", notice: "teacher_invited" }],
    ["invited_existing", { kind: "leave", to: "/admin/maestros", notice: "teacher_invited" }],
    ["already_invited", { kind: "failed", reason: "already_invited" }],
    ["already_teacher", { kind: "failed", reason: "already_teacher" }],
    ["self", { kind: "failed", reason: "self" }],
    ["ineligible", { kind: "failed", reason: "ineligible" }],
    ["unavailable", { kind: "failed", reason: "no_texts" }],
    ["invalid", { kind: "failed", reason: "invalid" }],
    ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
    ["forbidden", { kind: "leave", to: "/admin/maestros", notice: null }],
  ] as const)("invitar con %s", (answer, expected) => {
    expect(inviteOutcome(answered(answer))).toEqual(expected);
  });

  it("revocar y reenviar vuelven a la lista con su aviso", () => {
    expect(revokeOutcome(answered("revoked"))).toEqual({ kind: "leave", to: "/admin/maestros", notice: "teacher_invitation_revoked" });
    expect(reinviteOutcome(answered("invited_new"))).toEqual({ kind: "leave", to: "/admin/maestros", notice: "teacher_reinvited" });
    expect(reinviteOutcome(answered("invited_existing"))).toEqual({ kind: "leave", to: "/admin/maestros", notice: "teacher_reinvited" });
  });

  it.each([
    ["set", { kind: "leave", to: PAGE, notice: "teacher_founder_saved" }],
    ["cleared", { kind: "leave", to: PAGE, notice: "teacher_founder_saved" }],
    ["unchanged", { kind: "leave", to: PAGE, notice: null }],
    ["too_early", { kind: "failed", reason: "too_early" }],
    ["locked", { kind: "failed", reason: "locked" }],
    ["self", { kind: "failed", reason: "self" }],
  ] as const)("fundador con %s", (answer, expected) => {
    expect(founderOutcome(answered(answer), PAGE)).toEqual(expected);
  });

  it.each([
    ["suspended", { kind: "leave", to: PAGE, notice: "teacher_suspended" }],
    ["already_suspended", { kind: "failed", reason: "already_suspended" }],
    ["not_active", { kind: "failed", reason: "not_active" }],
  ] as const)("suspender con %s", (answer, expected) => {
    expect(suspendOutcome(answered(answer), PAGE)).toEqual(expected);
  });

  it.each([
    ["lifted", { kind: "leave", to: PAGE, notice: "teacher_lifted" }],
    ["proposer", { kind: "failed", reason: "proposer" }],
    ["not_suspended", { kind: "failed", reason: "not_suspended" }],
  ] as const)("levantar con %s", (answer, expected) => {
    expect(liftOutcome(answered(answer), PAGE)).toEqual(expected);
  });

  it.each([
    ["confirmed", { kind: "leave", to: PAGE, notice: "teacher_fraud_confirmed" }],
    ["rejected", { kind: "leave", to: PAGE, notice: "teacher_fraud_rejected" }],
    ["proposer", { kind: "failed", reason: "proposer" }],
    ["not_found", { kind: "failed", reason: "not_found" }],
  ] as const)("decidir con %s", (answer, expected) => {
    expect(decideOutcome(answered(answer), PAGE)).toEqual(expected);
  });
});

describe("lo que el servicio contesta sin preguntarle a la base", () => {
  it.each([
    [{ kind: "refused" as const }, { kind: "leave", to: PAGE, notice: null }],
    [{ kind: "unavailable" as const }, { kind: "failed", reason: "unavailable" }],
    // «No se supo» nunca se pinta como hecho.
    [{ kind: "unknown" as const }, { kind: "failed", reason: "unknown" }],
    [{ kind: "malformed" as const }, { kind: "failed", reason: "invalid" }],
    [{ kind: "changed" as const }, { kind: "failed", reason: "changed" }],
  ])("%j", (result, expected) => {
    expect(suspendOutcome(result, PAGE)).toEqual(expected);
  });
});
