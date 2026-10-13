import { describe, expect, it } from "vitest";

import type { PendingAccount, SignInResult } from "@/services/account/account";

import { checkSignInForm, readSignInForm, signInOutcome } from "./outcomes";

// Qué hace la pantalla de entrar con lo que contesta el servicio (diseño, PA-11; FL-05).

const pending: PendingAccount = {
  variant: "complete_account",
  missing: { name: true, adultDeclaration: true, documents: [] },
};
const retryAt = new Date("2026-10-11T18:30:00.000Z");

describe("lo que contesta el servicio de entrada", () => {
  it.each<[string, SignInResult, ReturnType<typeof signInOutcome>]>([
    ["entró, sin pendientes", { kind: "entered", pending: null, team: "none" }, { kind: "redirect", to: "/inicio?x=1", notice: null }],
    ["entró, y no se supo su estado en el equipo", { kind: "entered", pending: null, team: null }, { kind: "redirect", to: "/inicio?x=1", notice: null }],
    [
      "entró, y le falta completar su cuenta",
      { kind: "entered", pending, team: null },
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
    const destinations = results.map((result) => {
      const outcome = signInOutcome(result, "/inicio");
      return outcome.kind === "redirect" ? outcome.to : null;
    });
    // Ninguno llega al destino guardado: el único que sale, sale a recuperar.
    expect(destinations).toEqual([null, null, null, null, null, "/recuperar"]);
  });

  // El estado en el equipo de quien entró dice a qué pantalla va (flujo de la app §6.2). La
  // tabla completa está en navigation.test.ts; aquí, que esta pantalla la obedece.
  it.each([
    ["invited", "", "/entrar/segundo-factor/configurar"],
    ["invited_unproven", "/admin", "/entrar/segundo-factor/configurar"],
    ["unbound", "", "/entrar/segundo-factor"],
    ["needs_code", "", "/entrar/segundo-factor"],
    ["needs_code", "/admin/equipo", "/entrar/segundo-factor?volver=%2Fadmin%2Fequipo"],
    // Quien pidió otra pantalla va a esa pantalla: el código solo se pide en administración.
    ["needs_code", "/cuenta", "/cuenta"],
    ["member", "", "/admin"],
    ["none", "/admin", "/admin"],
  ] as const)("entró y su estado en el equipo es %s, con destino «%s»: va a %s", (team, returnTo, to) => {
    expect(signInOutcome({ kind: "entered", pending: null, team }, returnTo)).toEqual({ kind: "redirect", to, notice: null });
  });

  it("a quien le falta algo de su cuenta se le pide eso antes que el segundo factor", () => {
    expect(signInOutcome({ kind: "entered", pending, team: "needs_code" }, "/admin")).toEqual({
      kind: "redirect",
      to: "/consentimientos?volver=%2Fadmin",
      notice: null,
    });
  });

  it.each(["", "//otro.example", "https://otro.example", "/entrar", "/consentimientos", "/sesion/cerrar"])(
    "un destino que no vale lleva al inicio: %s",
    (returnTo) => {
      expect(signInOutcome({ kind: "entered", pending: null, team: "none" }, returnTo)).toEqual({
        kind: "redirect",
        to: "/inicio",
        notice: null,
      });
      expect(signInOutcome({ kind: "entered", pending, team: null }, returnTo)).toEqual({
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

describe("lo que llega del formulario", () => {
  function form(entries: [string, string | Blob][]): FormData {
    const data = new FormData();
    for (const [name, value] of entries) data.append(name, value);
    return data;
  }
  const empty = { email: "", password: "", returnTo: "" };

  it("el correo, la contraseña y el destino, tal como llegaron", () => {
    expect(readSignInForm(form([["email", " Ana@Prueba.test "], ["password", " secreta "], ["volver", "/inicio?x=1"]]))).toEqual({
      email: " Ana@Prueba.test ",
      password: " secreta ",
      returnTo: "/inicio?x=1",
    });
  });

  it("lo que falta cuenta como vacío", () => {
    expect(readSignInForm(form([]))).toEqual(empty);
    expect(readSignInForm(form([["email", "ana@prueba.test"]]))).toEqual({ ...empty, email: "ana@prueba.test" });
  });

  it("lo que no es un texto cuenta como vacío", () => {
    const file = new Blob(["x"]);
    expect(readSignInForm(form([["email", file], ["password", file], ["volver", file]]))).toEqual(empty);
  });

  it.each([
    ["email", 320],
    ["password", 1_024],
    ["volver", 2_048],
  ] as const)("%s: hasta %i caracteres pasa, uno más cuenta como vacío", (name, max) => {
    const key = name === "volver" ? "returnTo" : name;
    expect(readSignInForm(form([[name, "x".repeat(max)]]))[key]).toHaveLength(max);
    expect(readSignInForm(form([[name, "x".repeat(max + 1)]]))[key]).toBe("");
  });

  it.each([null, undefined, "email=ana", 42, {}, [], new URLSearchParams("email=ana@prueba.test")])(
    "lo que no es un formulario cuenta como un formulario vacío: %j",
    (notAForm) => {
      expect(readSignInForm(notAForm)).toEqual(empty);
    },
  );

  it("con el nombre repetido toma el primero", () => {
    expect(readSignInForm(form([["volver", "/inicio"], ["volver", "//otro.example"]])).returnTo).toBe("/inicio");
  });
});
