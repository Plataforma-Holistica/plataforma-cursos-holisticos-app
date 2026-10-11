import { describe, expect, it } from "vitest";

import { PASSWORD_MIN_LENGTH } from "@/domain/access/password-policy";

import {
  accountClaimed,
  checkAccountForm,
  checkRegistrationForm,
  linkOpensRegistration,
  matchAccepted,
  type CurrentText,
} from "./forms";

// Lo que los formularios de la cuenta mandan, revisado antes de tocar nada (RF-101, RF-108,
// RF-109; flujo de la app FL-03 y FL-06). Aquí nada se gasta: ni el enlace ni un intento.

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";
const OLD = "d0000000-0000-4000-8000-00000000000d";

const texts: CurrentText[] = [
  { docType: "terms", documentId: A, version: 3, title: "Términos" },
  { docType: "student_privacy_notice", documentId: B, version: 2, title: "Aviso" },
  { docType: "course_history_consent", documentId: C, version: 1, title: "Historial" },
];
const all = ["terms", "student_privacy_notice", "course_history_consent"];

describe("matchAccepted", () => {
  it("con los tres textos vigentes aceptados, pasa y dice cuáles", () => {
    expect(matchAccepted(texts, all, [C, A, B])).toEqual({ kind: "ok", documentIds: [C, A, B] });
  });

  it("uno que hacía falta y no viene es lo que falta por aceptar", () => {
    expect(matchAccepted(texts, all, [A, B])).toEqual({ kind: "missing" });
    expect(matchAccepted(texts, all, [])).toEqual({ kind: "missing" });
  });

  it("uno que ya no es el vigente dice que los textos cambiaron, falte o no otro", () => {
    expect(matchAccepted(texts, all, [A, B, OLD])).toEqual({ kind: "stale" });
    expect(matchAccepted(texts, all, [A, B, C, OLD])).toEqual({ kind: "stale" });
  });

  it("solo se exigen los que hacen falta: aceptar de más un vigente no estorba", () => {
    expect(matchAccepted(texts, ["terms"], [A])).toEqual({ kind: "ok", documentIds: [A] });
    expect(matchAccepted(texts, ["terms"], [A, B])).toEqual({ kind: "ok", documentIds: [A, B] });
    expect(matchAccepted(texts, ["terms"], [B])).toEqual({ kind: "missing" });
    expect(matchAccepted(texts, [], [])).toEqual({ kind: "ok", documentIds: [] });
  });

  it("repetir uno no cuenta dos veces", () => {
    expect(matchAccepted(texts, all, [A, A, B, C])).toEqual({ kind: "ok", documentIds: [A, B, C] });
    expect(matchAccepted(texts, all, [A, A, A])).toEqual({ kind: "missing" });
  });

  it("mayúsculas en el identificador no lo vuelven otro", () => {
    expect(matchAccepted(texts, ["terms"], [A.toUpperCase()])).toEqual({ kind: "ok", documentIds: [A] });
  });

  it.each([["no-es-un-uuid"], [""], [`${A}'; drop table consents; --`], [A.slice(0, 35)]])(
    "algo que no tiene forma de identificador (%j) es un formulario que no sirve",
    (junk) => {
      expect(matchAccepted(texts, all, [A, B, C, junk])).toEqual({ kind: "stale" });
    },
  );

  it("si un tipo que hace falta no tiene texto vigente, no hay qué aceptar", () => {
    const [terms, privacy] = texts as [CurrentText, CurrentText, CurrentText];
    const without = [terms, privacy, { docType: "course_history_consent", documentId: null, version: null, title: null }];
    expect(matchAccepted(without, all, [A, B])).toEqual({ kind: "unavailable" });
    // Si no hace falta, no estorba.
    expect(matchAccepted(without, ["terms"], [A])).toEqual({ kind: "ok", documentIds: [A] });
    // Ni un tipo que hace falta y del que no se sabe nada.
    expect(matchAccepted([terms], all, [A])).toEqual({ kind: "unavailable" });
  });
});

describe("lo que se sabe de la cuenta de un enlace recién canjeado", () => {
  it("el enlace de verificación solo completa una cuenta activa que nadie ha reclamado", () => {
    expect(linkOpensRegistration({ status: "active", pending: true })).toBe(true);
  });

  it.each([
    ["sin perfil", null],
    ["ya reclamada", { status: "active", pending: false }],
    ["suspendida", { status: "suspended", pending: true }],
    ["eliminada", { status: "deleted", pending: true }],
    ["con un estado que no se conoce", { status: "", pending: true }],
  ])("una cuenta %s no", (_name, state) => {
    expect(linkOpensRegistration(state)).toBe(false);
  });

  it("la cuenta quedó reclamada si la base dijo que la reclamó o que ya lo estaba, y con nada más", () => {
    expect(accountClaimed("claimed")).toBe(true);
    expect(accountClaimed("already_claimed")).toBe(true);
    for (const other of ["ineligible", "", "CLAIMED", "noted"]) expect(accountClaimed(other)).toBe(false);
  });
});

describe("checkRegistrationForm", () => {
  const good = { name: "  Ana Pérez ", password: "x".repeat(PASSWORD_MIN_LENGTH), adultDeclared: true, accepted: [A, B, C] };

  it("con todo en orden devuelve el nombre ya recortado y la contraseña tal cual", () => {
    expect(checkRegistrationForm({ ...good, password: "  con espacios  " })).toEqual({
      ok: true,
      name: "Ana Pérez",
      password: "  con espacios  ",
    });
  });

  it("dice cada campo que falla, todos a la vez", () => {
    expect(checkRegistrationForm({ name: " ", password: "corta", adultDeclared: false, accepted: [] })).toEqual({
      ok: false,
      fields: { name: "empty", password: "too_short", adult: "required", texts: "required" },
    });
  });

  it.each([
    ["un nombre de puros signos", { name: "***" }, { name: "invalid" }],
    ["un nombre larguísimo", { name: "a".repeat(121) }, { name: "too_long" }],
    ["una contraseña de más de 72 bytes", { password: "ñ".repeat(37) }, { password: "too_long" }],
    ["una contraseña con un carácter de control", { password: "abc\u0000defgh" }, { password: "malformed" }],
    ["la edad sin declarar", { adultDeclared: false }, { adult: "required" }],
    ["ningún texto aceptado", { accepted: [] }, { texts: "required" }],
  ])("%s", (_name, change, fields) => {
    expect(checkRegistrationForm({ ...good, ...change })).toEqual({ ok: false, fields });
  });

  it("la edad se declara con un verdadero de verdad, no con algo que lo parezca", () => {
    const sloppy = { ...good, adultDeclared: "true" as unknown as boolean };
    expect(checkRegistrationForm(sloppy)).toEqual({ ok: false, fields: { adult: "required" } });
  });
});

describe("checkAccountForm", () => {
  const nothing = { name: false, adultDeclaration: false };

  it("solo revisa lo que a la cuenta le falta", () => {
    expect(checkAccountForm(nothing, { accepted: [] })).toEqual({ ok: true, name: null, adult: false });
    // Lo que no falta se ignora, venga como venga.
    expect(checkAccountForm(nothing, { name: "***", adultDeclared: false, accepted: [] })).toEqual({
      ok: true,
      name: null,
      adult: false,
    });
  });

  it("si falta el nombre, lo exige y lo devuelve recortado", () => {
    const needs = { name: true, adultDeclaration: false };
    expect(checkAccountForm(needs, { name: " Ana ", accepted: [] })).toEqual({ ok: true, name: "Ana", adult: false });
    expect(checkAccountForm(needs, { accepted: [] })).toEqual({ ok: false, fields: { name: "empty" } });
    expect(checkAccountForm(needs, { name: null, accepted: [] })).toEqual({ ok: false, fields: { name: "empty" } });
  });

  it("si falta la edad, exige declararla", () => {
    const needs = { name: false, adultDeclaration: true };
    expect(checkAccountForm(needs, { adultDeclared: true, accepted: [] })).toEqual({ ok: true, name: null, adult: true });
    expect(checkAccountForm(needs, { accepted: [] })).toEqual({ ok: false, fields: { adult: "required" } });
    expect(checkAccountForm(needs, { adultDeclared: false, accepted: [] })).toEqual({
      ok: false,
      fields: { adult: "required" },
    });
  });

  it("si faltan las dos cosas, dice las dos", () => {
    expect(checkAccountForm({ name: true, adultDeclaration: true }, { name: "", accepted: [] })).toEqual({
      ok: false,
      fields: { name: "empty", adult: "required" },
    });
  });
});
