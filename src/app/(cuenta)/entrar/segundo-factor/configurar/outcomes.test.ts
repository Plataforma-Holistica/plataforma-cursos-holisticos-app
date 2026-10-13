import { describe, expect, it } from "vitest";

import type { FactorConfirmation, FactorStart, VerifiedClaims } from "@/services/account/account";

import { checkConfirmForm, confirmOutcome, readConfirmForm, startOutcome } from "./outcomes";

// Qué hace la pantalla que configura el segundo factor con lo que contestan sus dos
// servicios (diseño, PA-12; flujo de la app §6.2).

const FACTOR = "22222222-2222-4222-8222-222222222222";
const claims = { userId: "11111111-1111-4111-8111-111111111111", aal: "aal1", sessionId: null, issuedAt: 0 } as VerifiedClaims;
type Refused = Extract<FactorStart, { kind: "anonymous" | "incomplete" | "must_sign_out" | "suspended" | "unavailable" }>;
type RefusedOutcome = Extract<ReturnType<typeof startOutcome>, { kind: "redirect" | "suspended" | "unavailable" }>;

const incomplete: Refused = {
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

/** Lo que la guarda de sesión niega, igual para las dos acciones. */
const REFUSALS: [string, Refused, RefusedOutcome][] = [
  ["sin sesión", { kind: "anonymous" }, { kind: "redirect", to: "/entrar", notice: null, closeSession: false }],
  ["a la cuenta le falta algo", incomplete, { kind: "redirect", to: "/consentimientos", notice: null, closeSession: false }],
  [
    "la sesión no vale, y la cuenta solo se abre recuperándola",
    { kind: "must_sign_out", then: "recover" },
    { kind: "redirect", to: "/recuperar", notice: "choose_password", closeSession: true },
  ],
  ["la sesión no vale", { kind: "must_sign_out", then: "sign_in" }, { kind: "redirect", to: "/entrar", notice: null, closeSession: true }],
  ["cuenta suspendida", { kind: "suspended" }, { kind: "suspended" }],
  ["no se supo", { kind: "unavailable" }, { kind: "unavailable" }],
];

describe("lo que contesta empezar", () => {
  const started: FactorStart = { kind: "started", factorId: FACTOR, secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", qr: "<svg></svg>" };

  it("empezó: lo que se pinta una vez, y el factor que la pantalla mandará de vuelta", () => {
    expect(startOutcome(started)).toEqual({
      kind: "started",
      factorId: FACTOR,
      secret: "JBSWY3DPEHPK3PXP",
      uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
      qr: "<svg></svg>",
    });
    expect(startOutcome({ ...started, qr: null })).toMatchObject({ kind: "started", qr: null });
  });

  it.each<[string, FactorStart, ReturnType<typeof startOutcome>]>([
    [
      "ya no tiene una invitación que pueda aceptar: la guarda de la pantalla vuelve a decidir",
      { kind: "not_invited" },
      { kind: "redirect", to: "/entrar/segundo-factor/configurar", notice: null, closeSession: false },
    ],
    ["no ha probado su buzón en este navegador", { kind: "needs_mailbox_proof" }, { kind: "needs_mailbox_proof" }],
    ["tiene un factor verificado que nadie ató", { kind: "needs_second_level" }, { kind: "needs_second_level" }],
    ...REFUSALS,
  ])("%s", (_name, result, expected) => {
    expect(startOutcome(result)).toEqual(expected);
  });

  it("la clave solo sale cuando el servicio dijo que empezó", () => {
    const others: FactorStart[] = [{ kind: "not_invited" }, { kind: "needs_mailbox_proof" }, { kind: "needs_second_level" }, ...REFUSALS.map(([, result]) => result)];
    for (const result of others) expect(JSON.stringify(startOutcome(result)), result.kind).not.toMatch(/secret|otpauth|svg/);
  });
});

describe("lo que llega del formulario de confirmar", () => {
  it("lee el código, el código dictado y el factor pintado, tal como llegaron", () => {
    expect(readConfirmForm(form([["code", "123 456"], ["handoff", "ab12-cd34"], ["painted", FACTOR]]))).toEqual({
      code: "123 456",
      handoff: "ab12-cd34",
      painted: FACTOR,
    });
  });

  it("lo que falta cuenta como vacío, y nada más del formulario se lee", () => {
    expect(readConfirmForm(form([["factor", FACTOR], ["secret", "JBSWY3DPEHPK3PXP"], ["volver", "/admin"]]))).toEqual({ code: "", handoff: "", painted: "" });
  });

  it.each([null, undefined, "code=123456", { code: "123456" }, 123456])("lo que no es un formulario (%j) cuenta como vacío", (value) => {
    expect(readConfirmForm(value)).toEqual({ code: "", handoff: "", painted: "" });
  });

  it("un archivo en lugar de un texto cuenta como vacío", () => {
    const file = new Blob(["123456"]);
    expect(readConfirmForm(form([["code", file], ["handoff", file], ["painted", file]]))).toEqual({ code: "", handoff: "", painted: "" });
  });

  it("lo desmedido cuenta como vacío, y lo que cabe justo se lee", () => {
    expect(readConfirmForm(form([["code", "1".repeat(64)]])).code).toHaveLength(64);
    expect(readConfirmForm(form([["code", "1".repeat(65)]])).code).toBe("");
    expect(readConfirmForm(form([["handoff", "A".repeat(128)]])).handoff).toHaveLength(128);
    expect(readConfirmForm(form([["handoff", "A".repeat(129)]])).handoff).toBe("");
    expect(readConfirmForm(form([["painted", "a".repeat(64)]])).painted).toHaveLength(64);
    expect(readConfirmForm(form([["painted", "a".repeat(65)]])).painted).toBe("");
  });
});

describe("la forma del código, antes de preguntarle a nadie", () => {
  it.each(["123456", "123 456", " 123456 "])("%j tiene forma de código", (code) => {
    expect(checkConfirmForm({ code })).toBeNull();
  });

  it.each([
    ["", "required"],
    ["   ", "required"],
    ["12345", "invalid"],
    ["12a456", "invalid"],
    ["123-456", "invalid"],
  ] as const)("%j: %s", (code, problem) => {
    expect(checkConfirmForm({ code })).toEqual({ code: problem });
  });
});

describe("lo que contesta confirmar", () => {
  it.each<[string, FactorConfirmation, ReturnType<typeof confirmOutcome>]>([
    [
      "aceptada: a entrar con su aviso, sin cerrar nada, porque la base ya la cerró",
      { kind: "accepted" },
      { kind: "redirect", to: "/entrar", notice: "second_factor_ready", closeSession: false },
    ],
    ["el código no coincide", { kind: "wrong_code" }, { kind: "invalid", fields: { code: "wrong" } }],
    [
      "el freno rechazó, y Auth cerró todas las sesiones",
      { kind: "throttled" },
      { kind: "redirect", to: "/entrar", notice: "second_factor_throttled", closeSession: false },
    ],
    ["la clave ya no es la vigente", { kind: "start_again" }, { kind: "start_again" }],
    ["no ha probado su buzón en este navegador", { kind: "needs_mailbox_proof" }, { kind: "needs_mailbox_proof" }],
    [
      "ya no tiene una invitación que pueda aceptar: la guarda de la pantalla vuelve a decidir",
      { kind: "not_invited" },
      { kind: "redirect", to: "/entrar/segundo-factor/configurar", notice: null, closeSession: false },
    ],
    [
      "la sesión se cerró en otro lado a media verificación",
      { kind: "signed_out" },
      { kind: "redirect", to: "/entrar", notice: "session_ended", closeSession: true },
    ],
    ...REFUSALS,
  ])("%s", (_name, result, expected) => {
    expect(confirmOutcome(result, "")).toEqual(expected);
  });

  it("el código dictado: si no se escribió, falta; si se escribió, no es ese", () => {
    expect(confirmOutcome({ kind: "needs_handoff" }, "")).toEqual({ kind: "invalid", fields: { handoff: "required" } });
    expect(confirmOutcome({ kind: "needs_handoff" }, "   ")).toEqual({ kind: "invalid", fields: { handoff: "required" } });
    expect(confirmOutcome({ kind: "needs_handoff" }, "AB12CD34")).toEqual({ kind: "invalid", fields: { handoff: "wrong" } });
    expect(confirmOutcome({ kind: "needs_handoff" }, "corto")).toEqual({ kind: "invalid", fields: { handoff: "wrong" } });
  });

  const results: FactorConfirmation[] = [
    { kind: "accepted" },
    { kind: "wrong_code" },
    { kind: "throttled" },
    { kind: "start_again" },
    { kind: "needs_handoff" },
    { kind: "needs_mailbox_proof" },
    { kind: "not_invited" },
    { kind: "signed_out" },
    ...REFUSALS.map(([, result]) => result),
  ];

  it("solo una invitación aceptada lleva el aviso de que el segundo factor quedó configurado", () => {
    for (const result of results) {
      const outcome = confirmOutcome(result, "AB12CD34");
      const ready = outcome.kind === "redirect" && outcome.notice === "second_factor_ready";
      expect(ready, result.kind).toBe(result.kind === "accepted");
    }
  });

  it("solo se cierra la sesión cuando ya no vale; aceptada no, porque ya está cerrada", () => {
    const closing = results.filter((result) => {
      const outcome = confirmOutcome(result, "");
      return outcome.kind === "redirect" && outcome.closeSession;
    });
    expect(closing.map((result) => result.kind)).toEqual(["signed_out", "must_sign_out", "must_sign_out"]);
  });

  it("ninguna salida lleva a administración: la sesión de equipo nace entrando de nuevo", () => {
    for (const result of results) {
      const outcome = confirmOutcome(result, "");
      if (outcome.kind === "redirect") expect(outcome.to, result.kind).not.toMatch(/^\/admin/);
    }
  });
});
