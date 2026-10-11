import { describe, expect, it } from "vitest";

import type { PendingAccount, SignInResult } from "@/services/account/account";

import { checkSignInForm, signInOutcome } from "./outcomes";

// Qué hace la pantalla de entrar con lo que contesta el servicio (diseño, PA-11; FL-05).

const pending: PendingAccount = {
  variant: "complete_account",
  missing: { name: true, adultDeclaration: true, documents: [] },
};
const retryAt = new Date("2026-10-11T18:30:00.000Z");

describe("lo que contesta el servicio de entrada", () => {
  it.each<[string, SignInResult, ReturnType<typeof signInOutcome>]>([
    ["entró, sin pendientes", { kind: "entered", pending: null }, { kind: "redirect", to: "/inicio?x=1", notice: null }],
    [
      "entró, y le falta completar su cuenta",
      { kind: "entered", pending },
      { kind: "redirect", to: "/consentimientos?volver=%2Finicio%3Fx%3D1", notice: null },
    ],
    [
      "la contraseña no se fijó desde su buzón",
      { kind: "must_recover" },
      { kind: "redirect", to: "/recuperar", notice: "choose_password" },
    ],
    ["cuenta suspendida", { kind: "suspended" }, { kind: "suspended" }],
    ["credenciales", { kind: "invalid_credentials" }, { kind: "failed", reason: "invalid_credentials" }],
    ["tope por hora", { kind: "capped" }, { kind: "failed", reason: "capped" }],
    ["no se supo", { kind: "unavailable" }, { kind: "failed", reason: "unavailable" }],
    ["frenado", { kind: "throttled", retryAt }, { kind: "throttled", retryAt: "2026-10-11T18:30:00.000Z" }],
  ])("%s", (_name, result, expected) => {
    expect(signInOutcome(result, "/inicio?x=1")).toEqual(expected);
  });

  it("solo quien entró sale de la pantalla hacia dentro", () => {
    const results: SignInResult[] = [
      { kind: "invalid_credentials" },
      { kind: "capped" },
      { kind: "unavailable" },
      { kind: "suspended" },
      { kind: "throttled", retryAt },
      { kind: "must_recover" },
    ];
    for (const result of results) {
      const outcome = signInOutcome(result, "/inicio");
      if (outcome.kind === "redirect") expect(outcome.to).toBe("/recuperar");
    }
  });

  it.each(["", "//otro.example", "https://otro.example", "/entrar", "/consentimientos", "/sesion/cerrar"])(
    "un destino que no vale lleva al inicio: %s",
    (returnTo) => {
      expect(signInOutcome({ kind: "entered", pending: null }, returnTo)).toEqual({
        kind: "redirect",
        to: "/inicio",
        notice: null,
      });
      expect(signInOutcome({ kind: "entered", pending }, returnTo)).toEqual({
        kind: "redirect",
        to: "/consentimientos",
        notice: null,
      });
    },
  );
});

describe("lo que se revisa del formulario antes de preguntarle a nadie", () => {
  it.each([
    [{ email: "ana@prueba.test", password: "secreta-123" }, null],
    [{ email: "  ana@prueba.test  ", password: " " }, null],
    [{ email: "", password: "" }, { email: "required", password: "required" }],
    [{ email: "   ", password: "x" }, { email: "required" }],
    [{ email: "no es un correo", password: "x" }, { email: "invalid" }],
    [{ email: "ana@prueba", password: "" }, { email: "invalid", password: "required" }],
    [{ email: "ana@prueba.test", password: "" }, { password: "required" }],
  ])("%j", (input, expected) => {
    expect(checkSignInForm(input)).toEqual(expected);
  });

  it("no opina de la contraseña más allá de que venga: cuál es la correcta solo lo sabe Auth", () => {
    expect(checkSignInForm({ email: "ana@prueba.test", password: "a" })).toBeNull();
    expect(checkSignInForm({ email: "ana@prueba.test", password: "x".repeat(500) })).toBeNull();
  });
});
