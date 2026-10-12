import { describe, expect, it } from "vitest";

import type { PendingAccount } from "@/services/account/account";

import {
  changeNameOutcome,
  checkNameForm,
  CLOSE_OTHERS,
  closeOthersOutcome,
  closeSessionOutcome,
  readNameForm,
  readSessionsForm,
} from "./outcomes";

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

describe("lo que llega del formulario de las sesiones", () => {
  const ID = "5e560000-0000-0000-0000-000000000001";

  it("el botón de una sesión dice cuál", () => {
    expect(readSessionsForm(form([["close", ID]]))).toEqual({ target: "one", sessionId: ID });
  });

  it("el de «Cerrar todas las demás» no dice ninguna: cuál se queda lo sabe el servidor", () => {
    expect(CLOSE_OTHERS).toBe("others");
    expect(readSessionsForm(form([["close", "others"]]))).toEqual({ target: "others" });
  });

  it.each([
    ["sin el campo", form([])],
    ["con el campo vacío", form([["close", ""]])],
    ["con un archivo en lugar de un texto", form([["close", new Blob([ID])]])],
    ["con un texto más largo que un identificador", form([["close", `${ID}x`]])],
    ["algo que no es un formulario", `close=${ID}`],
    ["nada", null],
  ])("%s no se entiende qué cerrar, y no se cierra nada", (_case, input) => {
    expect(readSessionsForm(input)).toEqual({ target: "none" });
  });

  it("lo que no tiene forma de identificador llega como está: lo descarta el servicio", () => {
    expect(readSessionsForm(form([["close", "otras"]]))).toEqual({ target: "one", sessionId: "otras" });
  });

  it("del campo repetido vale el primero, y no lee ningún otro", () => {
    expect(readSessionsForm(form([["close", ID], ["close", "others"], ["keep", "x"], ["profile", "otra"]]))).toEqual({
      target: "one",
      sessionId: ID,
    });
  });
});

describe("qué se hace con lo que contesta el servicio al cerrar sesiones", () => {
  it("cerrada: se queda en la pantalla, y dice cuál", () => {
    expect(closeSessionOutcome({ kind: "closed" })).toEqual({ kind: "closed", what: "one" });
    expect(closeOthersOutcome({ kind: "closed", count: 3 })).toEqual({ kind: "closed", what: "others" });
    expect(closeOthersOutcome({ kind: "closed", count: 0 })).toEqual({ kind: "closed", what: "others" });
  });

  it("una que no se encontró se dice como ya cerrada: de otra cuenta o no, aquí no está abierta", () => {
    expect(closeSessionOutcome({ kind: "not_found" })).toEqual({ kind: "closed", what: "gone" });
  });

  it("la sesión propia, mandada por aquí: se cierra por el camino que borra la cookie, y a la portada", () => {
    expect(closeSessionOutcome({ kind: "current" })).toEqual({ kind: "redirect", to: "/", notice: null, closeSession: true });
  });

  it("no se supo: lo dice, y no se va a ningún lado", () => {
    expect(closeSessionOutcome({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
    expect(closeOthersOutcome({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
  });

  it.each([
    ["cerrar una", (check: never) => closeSessionOutcome({ kind: "session", check })],
    ["cerrar las demás", (check: never) => closeOthersOutcome({ kind: "session", check })],
  ] as const)("%s, sin una sesión que pase: lo mismo que cualquier otro bloque de la pantalla", (_case, outcome) => {
    expect(outcome({ kind: "anonymous" } as never)).toEqual({ kind: "redirect", to: "/entrar?volver=%2Fcuenta", notice: null, closeSession: false });
    expect(outcome({ kind: "incomplete" } as never)).toEqual({ kind: "redirect", to: "/consentimientos?volver=%2Fcuenta", notice: null, closeSession: false });
    expect(outcome({ kind: "suspended" } as never)).toEqual({ kind: "suspended" });
    expect(outcome({ kind: "unavailable" } as never)).toEqual({ kind: "unavailable" });
    expect(outcome({ kind: "must_sign_out", then: "recover" } as never)).toEqual({ kind: "redirect", to: "/recuperar", notice: "choose_password", closeSession: true });
    expect(outcome({ kind: "must_sign_out", then: "sign_in" } as never)).toEqual({ kind: "redirect", to: "/entrar", notice: null, closeSession: true });
  });
});
