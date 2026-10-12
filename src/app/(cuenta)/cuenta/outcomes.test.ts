import { describe, expect, it } from "vitest";

import type { PendingAccount } from "@/services/account/account";

import { changeNameOutcome, checkNameForm, readNameForm } from "./outcomes";

// Qué hace la pantalla de la cuenta con cada respuesta (diseño, PA-25; FL-27, paso 1).

const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 } as never;

function form(entries: [string, string | Blob][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

describe("lo que llega del formulario del nombre", () => {
  it("el nombre, tal como se escribió: lo recorta y lo revisa el servicio", () => {
    expect(readNameForm(form([["name", "  Ana de Prueba "]]))).toEqual({ name: "  Ana de Prueba " });
  });

  it.each([
    ["sin el campo", form([])],
    ["con un archivo en lugar de un texto", form([["name", new Blob(["Ana"])]])],
    ["con un texto desmedido", form([["name", "a".repeat(501)]])],
    ["algo que no es un formulario", "name=Ana"],
    ["nada", null],
  ])("%s cuenta como vacío", (_case, input) => {
    expect(readNameForm(input)).toEqual({ name: "" });
  });

  it("el texto más largo que se lee, completo: la medida la pone después el servicio", () => {
    const longest = "a".repeat(500);
    expect(readNameForm(form([["name", longest]]))).toEqual({ name: longest });
  });

  it("del campo repetido vale el primero", () => {
    expect(
      readNameForm(
        form([
          ["name", "Ana"],
          ["name", "Otra"],
        ]),
      ),
    ).toEqual({ name: "Ana" });
  });

  it("no lee ningún otro campo", () => {
    expect(readNameForm(form([["name", "Ana"], ["volver", "//otro.example"], ["id", "x"]]))).toEqual({ name: "Ana" });
  });
});

describe("lo que el navegador revisa antes de enviar", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["a".repeat(121), "too_long"],
    ["...", "invalid"],
    ["Ana\u0000", "invalid"],
  ])("%j: %s", (name, problem) => {
    expect(checkNameForm({ name })).toBe(problem);
  });

  it("un nombre que se puede guardar no tiene nada que corregir", () => {
    expect(checkNameForm({ name: " Ana de Prueba " })).toBeNull();
    expect(checkNameForm({ name: "a".repeat(120) })).toBeNull();
  });
});

describe("qué se hace con lo que contesta el servicio al cambiar el nombre", () => {
  it("guardado: se queda en la pantalla, con el nombre como quedó", () => {
    expect(changeNameOutcome({ kind: "saved", name: "Ana" })).toEqual({ kind: "saved", name: "Ana" });
  });

  it.each(["empty", "too_long", "invalid"] as const)("un nombre que no se puede guardar (%s) se marca en el campo", (reason) => {
    expect(changeNameOutcome({ kind: "invalid", reason })).toEqual({ kind: "invalid", problem: reason });
  });

  it("no se supo: lo dice, y no se va a ningún lado", () => {
    expect(changeNameOutcome({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
    expect(changeNameOutcome({ kind: "session", check: { kind: "unavailable" } })).toEqual({ kind: "unavailable" });
  });

  it("sin sesión: a entrar, para volver aquí", () => {
    expect(changeNameOutcome({ kind: "session", check: { kind: "anonymous" } })).toEqual({
      kind: "redirect",
      to: "/entrar?volver=%2Fcuenta",
      notice: null,
      closeSession: false,
    });
  });

  it("a la cuenta le falta algo: primero lo completa, y vuelve aquí", () => {
    const pending: PendingAccount = {
      variant: "updated_texts",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
    };
    expect(changeNameOutcome({ kind: "session", check: { kind: "incomplete", claims, ...pending } })).toEqual({
      kind: "redirect",
      to: "/consentimientos?volver=%2Fcuenta",
      notice: null,
      closeSession: false,
    });
  });

  it("cuenta suspendida: PA-35", () => {
    expect(changeNameOutcome({ kind: "session", check: { kind: "suspended" } })).toEqual({ kind: "suspended" });
  });

  it("una sesión que ya no vale se cierra antes de irse: a recuperar, con su aviso, o a entrar", () => {
    expect(changeNameOutcome({ kind: "session", check: { kind: "must_sign_out", then: "recover" } })).toEqual({
      kind: "redirect",
      to: "/recuperar",
      notice: "choose_password",
      closeSession: true,
    });
    expect(changeNameOutcome({ kind: "session", check: { kind: "must_sign_out", then: "sign_in" } })).toEqual({
      kind: "redirect",
      to: "/entrar",
      notice: null,
      closeSession: true,
    });
  });
});
