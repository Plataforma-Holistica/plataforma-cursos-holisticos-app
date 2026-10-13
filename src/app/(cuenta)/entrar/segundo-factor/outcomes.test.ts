import { describe, expect, it } from "vitest";

import type { CodeGiven, VerifiedClaims } from "@/services/account/account";

import { checkCode, giveCodeOutcome, readGiveCodeForm } from "./outcomes";

// Qué hace la pantalla que pide el código del segundo factor con lo que contesta el
// servicio (diseño, PA-12; flujo de la app §6.2).

const claims = { userId: "11111111-1111-4111-8111-111111111111", aal: "aal1", sessionId: null, issuedAt: 0 } as VerifiedClaims;
const incomplete: CodeGiven = {
  kind: "incomplete",
  claims,
  variant: "updated_texts",
  missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
};

const form = (entries: [string, string | Blob][]) => {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
};

describe("lo que llega del formulario", () => {
  it("lee el código y el destino guardado, tal como llegaron", () => {
    expect(readGiveCodeForm(form([["code", "123 456"], ["volver", "/admin/equipo"]]))).toEqual({ code: "123 456", returnTo: "/admin/equipo" });
  });

  it("lo que falta cuenta como vacío", () => {
    expect(readGiveCodeForm(form([]))).toEqual({ code: "", returnTo: "" });
  });

  it.each([null, undefined, "code=123456", { code: "123456" }, 123456, ["123456"]])("lo que no es un formulario (%j) cuenta como vacío", (value) => {
    expect(readGiveCodeForm(value)).toEqual({ code: "", returnTo: "" });
  });

  it("un archivo en lugar de un texto cuenta como vacío", () => {
    const file = new Blob(["123456"]);
    expect(readGiveCodeForm(form([["code", file], ["volver", file]]))).toEqual({ code: "", returnTo: "" });
  });

  it("lo desmedido cuenta como vacío, y lo que cabe justo se lee", () => {
    expect(readGiveCodeForm(form([["code", "1".repeat(64)]])).code).toBe("1".repeat(64));
    expect(readGiveCodeForm(form([["code", "1".repeat(65)]])).code).toBe("");
    expect(readGiveCodeForm(form([["volver", `/admin/${"a".repeat(2_041)}`]])).returnTo).toHaveLength(2_048);
    expect(readGiveCodeForm(form([["volver", `/admin/${"a".repeat(2_042)}`]])).returnTo).toBe("");
  });

  it("con el campo repetido se lee el primero", () => {
    expect(readGiveCodeForm(form([["code", "111111"], ["code", "222222"]])).code).toBe("111111");
  });
});

describe("la forma del código, antes de preguntarle a nadie", () => {
  it.each(["123456", "123 456", " 123456 ", "1 2 3 4 5 6", "000000"])("%j tiene forma de código", (code) => {
    expect(checkCode(code)).toBeNull();
  });

  it.each(["", "   ", "\t"])("%j: falta escribirlo", (code) => {
    expect(checkCode(code)).toBe("required");
  });

  it.each(["12345", "1234567", "12a456", "123-456", "１２３４５６", "abcdef"])("%j no tiene forma de código", (code) => {
    expect(checkCode(code)).toBe("invalid");
  });
});

describe("lo que contesta el servicio", () => {
  it.each<[string, CodeGiven, ReturnType<typeof giveCodeOutcome>]>([
    ["el código vale", { kind: "verified" }, { kind: "redirect", to: "/admin/equipo", notice: null, closeSession: false }],
    ["el código no coincide", { kind: "wrong_code" }, { kind: "failed", reason: "wrong_code" }],
    [
      "el freno rechazó, y Auth cerró todas las sesiones",
      { kind: "throttled" },
      { kind: "redirect", to: "/entrar", notice: "second_factor_throttled", closeSession: false },
    ],
    [
      "ya no está a un código de entrar: la guarda de la pantalla vuelve a decidir",
      { kind: "not_member" },
      { kind: "redirect", to: "/entrar/segundo-factor?volver=%2Fadmin%2Fequipo", notice: null, closeSession: false },
    ],
    [
      "la sesión se cerró en otro lado a media verificación",
      { kind: "signed_out" },
      { kind: "redirect", to: "/entrar", notice: "session_ended", closeSession: true },
    ],
    ["sin sesión", { kind: "anonymous" }, { kind: "redirect", to: "/entrar?volver=%2Fadmin%2Fequipo", notice: null, closeSession: false }],
    [
      "a la cuenta le falta algo",
      incomplete,
      { kind: "redirect", to: "/consentimientos?volver=%2Fadmin%2Fequipo", notice: null, closeSession: false },
    ],
    [
      "la sesión no vale, y la cuenta solo se abre recuperándola",
      { kind: "must_sign_out", then: "recover" },
      { kind: "redirect", to: "/recuperar", notice: "choose_password", closeSession: true },
    ],
    [
      "la sesión no vale",
      { kind: "must_sign_out", then: "sign_in" },
      { kind: "redirect", to: "/entrar", notice: null, closeSession: true },
    ],
    ["cuenta suspendida", { kind: "suspended" }, { kind: "suspended" }],
    ["no se supo", { kind: "unavailable" }, { kind: "failed", reason: "unavailable" }],
  ])("%s", (_name, result, expected) => {
    expect(giveCodeOutcome(result, "/admin/equipo")).toEqual(expected);
  });

  const results: CodeGiven[] = [
    { kind: "verified" },
    { kind: "wrong_code" },
    { kind: "throttled" },
    { kind: "not_member" },
    { kind: "signed_out" },
    { kind: "anonymous" },
    incomplete,
    { kind: "must_sign_out", then: "recover" },
    { kind: "must_sign_out", then: "sign_in" },
    { kind: "suspended" },
    { kind: "unavailable" },
  ];

  it("solo el código que vale lleva al destino guardado", () => {
    for (const result of results) {
      const outcome = giveCodeOutcome(result, "/admin/equipo");
      const reached = outcome.kind === "redirect" && outcome.to === "/admin/equipo";
      expect(reached, result.kind).toBe(result.kind === "verified");
    }
  });

  it("solo se cierra la sesión cuando ya no vale", () => {
    const closing = results.filter((result) => {
      const outcome = giveCodeOutcome(result, "");
      return outcome.kind === "redirect" && outcome.closeSession;
    });
    expect(closing.map((result) => result.kind)).toEqual(["signed_out", "must_sign_out", "must_sign_out"]);
  });

  it("«no se supo» no saca a nadie de la pantalla ni le cierra nada", () => {
    expect(giveCodeOutcome({ kind: "unavailable" }, "/admin").kind).toBe("failed");
  });

  it.each(["", "//otro.example", "https://otro.example/admin", "/entrar", "/entrar/segundo-factor", "/administrar"])(
    "con un destino que no vale (%j), el código que vale lleva a administración, y nada se pasea por la dirección",
    (returnTo) => {
      expect(giveCodeOutcome({ kind: "verified" }, returnTo)).toMatchObject({ to: "/admin" });
      expect(giveCodeOutcome({ kind: "not_member" }, returnTo)).toMatchObject({ to: "/entrar/segundo-factor" });
      expect(giveCodeOutcome({ kind: "anonymous" }, returnTo)).toMatchObject({ to: "/entrar" });
      expect(giveCodeOutcome(incomplete, returnTo)).toMatchObject({ to: "/consentimientos" });
    },
  );

  it("quien pidió otra pantalla propia vuelve a ella con el código dado", () => {
    expect(giveCodeOutcome({ kind: "verified" }, "/cuenta")).toMatchObject({ to: "/cuenta" });
  });
});
