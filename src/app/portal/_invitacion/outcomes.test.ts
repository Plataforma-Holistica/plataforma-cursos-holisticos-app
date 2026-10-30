import { describe, expect, it } from "vitest";

import { ACCEPT_ANSWERS } from "@/services/teachers/standing";

import { acceptOutcome, readInvitationForm } from "./outcomes";

const AGREEMENT = "c0000000-0000-4000-8000-000000000001";
const NOTICE = "c0000000-0000-4000-8000-000000000002";

function formOf(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

describe("el formulario de PA-40", () => {
  it("lee los dos textos que se mostraron y las dos casillas", () => {
    expect(readInvitationForm(formOf({ agreement: AGREEMENT, notice: NOTICE, agreed: "on", notice_agreed: "on" }))).toEqual({
      shown: { agreement: AGREEMENT, notice: NOTICE },
      agreed: true,
      noticeAgreed: true,
    });
  });

  it("una casilla sin marcar se lee como tal", () => {
    expect(readInvitationForm(formOf({ agreement: AGREEMENT, notice: NOTICE, agreed: "on" }))).toMatchObject({ agreed: true, noticeAgreed: false });
  });

  it.each([
    [{ agreement: "no-es-un-id", notice: NOTICE }],
    [{ agreement: AGREEMENT, notice: "'; drop table" }],
    [{ agreement: AGREEMENT }],
  ])("un texto sin forma no se lee: %j", (fields) => {
    expect(readInvitationForm(formOf(fields as Record<string, string>)).shown).toBeNull();
  });
});

describe("lo que PA-40 hace con cada respuesta", () => {
  it("aceptada: al portal, con su aviso", () => {
    expect(acceptOutcome({ kind: "accepted" })).toEqual({ kind: "leave", to: "/portal", notice: "teacher_accepted" });
  });

  it("no se supo: nunca como hecho", () => {
    expect(acceptOutcome({ kind: "unknown" })).toEqual({ kind: "repaint", reason: "unknown" });
  });

  it.each([
    ["changed", { kind: "repaint", reason: "changed" }],
    // La página vuelve a preguntar la guarda, y pinta «prueba tu correo».
    ["needs_mailbox_proof", { kind: "repaint", reason: null }],
    ["already_teacher", { kind: "leave", to: "/portal", notice: null }],
    ["no_invitation", { kind: "repaint", reason: "gone" }],
    // No se dice por qué: quien invitó ya no puede, y eso no es de quien acepta.
    ["inviter_lost_content", { kind: "repaint", reason: "gone" }],
    ["unavailable", { kind: "repaint", reason: "unavailable" }],
    ["ineligible", { kind: "repaint", reason: "unavailable" }],
  ] as const)("%s", (answer, expected) => {
    expect(acceptOutcome({ kind: "answered", answer })).toEqual(expected);
  });

  it("cada respuesta de la base que no es aceptada tiene su caso", () => {
    for (const answer of ACCEPT_ANSWERS) {
      if (answer === "accepted") continue;
      expect(acceptOutcome({ kind: "answered", answer }), answer).toBeDefined();
    }
  });

  it.each([
    [{ kind: "anonymous" as const }, { kind: "leave", to: "/portal/invitacion", notice: null }],
    [{ kind: "must_sign_out" as const, then: "sign_in" as const }, { kind: "leave", to: "/entrar", notice: null, closeSession: true }],
    [{ kind: "suspended" as const }, { kind: "suspended" }],
    [{ kind: "unavailable" as const }, { kind: "repaint", reason: "unavailable" }],
  ])("lo que la guarda no dejó pasar: %j", (check, expected) => {
    expect(acceptOutcome({ kind: "refused", check })).toEqual(expected);
  });
});
