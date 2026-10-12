import { describe, expect, it } from "vitest";

import type { MailRequestResult } from "@/services/account/account";

import { checkEmailField, mailRequestOutcome, readEmailForm } from "./mail-request";

function form(entries: [string, string | Blob][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

describe("lo que llega de un formulario que pide un correo", () => {
  it("el correo, tal como llegó", () => {
    expect(readEmailForm(form([["email", " Ana@Prueba.test "]]))).toEqual({ email: " Ana@Prueba.test " });
  });

  it("lo que falta, lo que no es un texto y lo desmedido cuentan como vacío", () => {
    expect(readEmailForm(form([]))).toEqual({ email: "" });
    expect(readEmailForm(form([["email", new Blob(["ana@prueba.test"])]]))).toEqual({ email: "" });
    expect(readEmailForm(form([["email", "x".repeat(320)]])).email).toHaveLength(320);
    expect(readEmailForm(form([["email", "x".repeat(321)]]))).toEqual({ email: "" });
  });

  it.each([null, undefined, "email=ana@prueba.test", 42, {}, new URLSearchParams("email=ana@prueba.test")])(
    "lo que no es un formulario cuenta como un formulario vacío: %j",
    (notAForm) => {
      expect(readEmailForm(notAForm)).toEqual({ email: "" });
    },
  );

  it("con el nombre repetido toma el primero", () => {
    expect(readEmailForm(form([["email", "ana@prueba.test"], ["email", "otra@prueba.test"]]))).toEqual({ email: "ana@prueba.test" });
  });
});

describe("lo que se revisa del correo antes de preguntarle a nadie", () => {
  it.each([
    ["ana@prueba.test", null],
    ["  Ana@Prueba.test  ", null],
    ["ana+etiqueta@prueba.test", null],
    ["", "required"],
    ["   ", "required"],
    ["ana", "invalid"],
    ["ana@prueba", "invalid"],
    ["ana@@prueba.test", "invalid"],
    ["añá@prueba.test", "invalid"],
  ])("%j: %j", (email, expected) => {
    expect(checkEmailField(email)).toBe(expected);
  });
});

describe("lo que contesta el servicio a quien pide un correo", () => {
  it.each<[MailRequestResult, ReturnType<typeof mailRequestOutcome>]>([
    [{ kind: "accepted" }, { kind: "accepted" }],
    [{ kind: "invalid_email", reason: "malformed" }, { kind: "invalid", field: "invalid" }],
    [{ kind: "wait" }, { kind: "failed", reason: "wait" }],
    [{ kind: "unavailable" }, { kind: "failed", reason: "unavailable" }],
  ])("%j", (result, expected) => {
    expect(mailRequestOutcome(result)).toEqual(expected);
  });

  it("nada de lo que contesta dice si el correo tiene cuenta: solo hay un «aceptado»", () => {
    const kinds = new Set(
      ([{ kind: "accepted" }, { kind: "wait" }, { kind: "unavailable" }] as MailRequestResult[]).map((result) => mailRequestOutcome(result).kind),
    );
    expect([...kinds].sort()).toEqual(["accepted", "failed"]);
  });
});
