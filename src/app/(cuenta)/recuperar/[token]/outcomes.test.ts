import { describe, expect, it } from "vitest";

import type { RecoveryCompletion } from "@/services/account/account";

import { checkNewPassword, completeRecoveryOutcome, readChangePasswordForm, type ChangePasswordOutcome } from "./outcomes";

// Qué hace la pantalla que cambia la contraseña desde el enlace del correo (diseño, PA-13;
// FL-06).

function form(entries: [string, string | Blob][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

describe("lo que llega del formulario", () => {
  it("la huella y la contraseña, tal como llegaron", () => {
    expect(readChangePasswordForm(form([["token", "abcdefgh12345678"], ["password", "  una clave  "]]))).toEqual({
      token: "abcdefgh12345678",
      password: "  una clave  ",
    });
  });

  it("lo que falta, lo que no es texto y lo desmedido cuentan como vacío", () => {
    expect(readChangePasswordForm(form([]))).toEqual({ token: "", password: "" });
    const blob = new Blob(["x"]);
    expect(readChangePasswordForm(form([["token", blob], ["password", blob]]))).toEqual({ token: "", password: "" });
    expect(readChangePasswordForm(form([["token", "t".repeat(257)], ["password", "p".repeat(1_025)]]))).toEqual({ token: "", password: "" });
    const fits = readChangePasswordForm(form([["token", "t".repeat(256)], ["password", "p".repeat(1_024)]]));
    expect([fits.token.length, fits.password.length]).toEqual([256, 1_024]);
  });

  it.each([null, undefined, "password=abc", 42, {}, new URLSearchParams("password=abc")])(
    "lo que no es un formulario cuenta como un formulario vacío: %j",
    (notAForm) => {
      expect(readChangePasswordForm(notAForm)).toEqual({ token: "", password: "" });
    },
  );
});

describe("la regla de la contraseña, antes de enviar", () => {
  it.each([
    ["una clave larga", null],
    ["12345678", null],
    ["x".repeat(72), null],
    ["", "too_short"],
    ["1234567", "too_short"],
    ["x".repeat(73), "too_long"],
    ["con\u0000nulo", "malformed"],
  ])("%j: %j", (password, expected) => {
    expect(checkNewPassword(password)).toBe(expected);
  });
});

describe("lo que contesta el servicio", () => {
  it.each<[RecoveryCompletion, ChangePasswordOutcome]>([
    [{ kind: "done" }, { kind: "redirect", to: "/entrar", notice: "password_changed", closeSession: true }],
    [{ kind: "invalid", reason: "too_short" }, { kind: "invalid", problem: "too_short" }],
    [{ kind: "invalid", reason: "too_long" }, { kind: "invalid", problem: "too_long" }],
    [{ kind: "invalid", reason: "malformed" }, { kind: "invalid", problem: "malformed" }],
    [{ kind: "link_dead" }, { kind: "link_dead" }],
    [{ kind: "request_new_link" }, { kind: "request_new_link" }],
    [{ kind: "unavailable" }, { kind: "unavailable" }],
  ])("%j", (result, expected) => {
    expect(completeRecoveryOutcome(result)).toEqual(expected);
  });

  it("solo el cambio hecho saca de la pantalla, y nunca abre sesión: manda a entrar", () => {
    const results: RecoveryCompletion[] = [
      { kind: "invalid", reason: "too_short" },
      { kind: "link_dead" },
      { kind: "request_new_link" },
      { kind: "unavailable" },
    ];
    for (const result of results) expect(completeRecoveryOutcome(result).kind).not.toBe("redirect");
  });
});
