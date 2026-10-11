import { describe, expect, it } from "vitest";

import type { PendingAccount, SessionCheck, VerifiedClaims } from "@/services/account/account";

import { closedSessionRoute, consentsPageStep, sessionPageStep, visitorPageStep } from "./guard-steps";

// Qué hace cada tipo de pantalla con lo que contesta la guarda de sesión (flujo de la app
// §6.2 y §6.3). La guarda decide; esto solo traduce su respuesta a pintar o a redirigir.

const claims = { userId: "11111111-1111-4111-8111-111111111111", aal: "aal1", sessionId: null, issuedAt: 0 } as VerifiedClaims;
const pending: PendingAccount = {
  variant: "complete_account",
  missing: { name: true, adultDeclaration: false, documents: [{ docType: "terms", why: "never_given" }] },
};

const checks: Record<string, SessionCheck> = {
  anonymous: { kind: "anonymous" },
  pass: { kind: "pass", claims },
  incomplete: { kind: "incomplete", claims, ...pending },
  suspended: { kind: "suspended" },
  closeToRecover: { kind: "must_sign_out", then: "recover" },
  closeToSignIn: { kind: "must_sign_out", then: "sign_in" },
  unavailable: { kind: "unavailable" },
};
const check = (name: keyof typeof checks): SessionCheck => {
  const found = checks[name];
  if (!found) throw new Error(`No hay un caso llamado ${name}.`);
  return found;
};

describe("una pantalla con sesión", () => {
  it.each([
    ["anonymous", { kind: "redirect", to: "/entrar?volver=%2Finicio" }],
    ["pass", { kind: "render", claims }],
    ["incomplete", { kind: "redirect", to: "/consentimientos?volver=%2Finicio" }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
  ] as const)("%s", (name, expected) => {
    expect(sessionPageStep(check(name), "/inicio")).toEqual(expected);
  });

  it("solo se pinta cuando la guarda dijo que pasa", () => {
    for (const [name, value] of Object.entries(checks)) {
      expect(sessionPageStep(value, "/inicio").kind === "render").toBe(name === "pass");
    }
  });

  it("guarda la ruta que se pidió, con su consulta", () => {
    expect(sessionPageStep(check("anonymous"), "/inicio/algo?x=1")).toEqual({
      kind: "redirect",
      to: "/entrar?volver=%2Finicio%2Falgo%3Fx%3D1",
    });
    expect(sessionPageStep(check("incomplete"), "/inicio/algo?x=1")).toEqual({
      kind: "redirect",
      to: "/consentimientos?volver=%2Finicio%2Falgo%3Fx%3D1",
    });
  });
});

describe("la pantalla que pide lo que le falta a la cuenta", () => {
  it.each([
    ["anonymous", { kind: "redirect", to: "/entrar?volver=%2Finicio%3Fx%3D1" }],
    ["pass", { kind: "redirect", to: "/inicio?x=1" }],
    ["incomplete", { kind: "render", claims, pending }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
  ] as const)("%s", (name, expected) => {
    expect(consentsPageStep(check(name), "/inicio?x=1")).toEqual(expected);
  });

  it("a quien ya no le falta nada lo manda a donde iba, y si ese destino no vale, al inicio", () => {
    expect(consentsPageStep(check("pass"), null)).toEqual({ kind: "redirect", to: "/inicio" });
    expect(consentsPageStep(check("pass"), "//otro.example")).toEqual({ kind: "redirect", to: "/inicio" });
    expect(consentsPageStep(check("pass"), "/consentimientos")).toEqual({ kind: "redirect", to: "/inicio" });
    expect(consentsPageStep(check("anonymous"), "//otro.example")).toEqual({ kind: "redirect", to: "/entrar" });
  });
});

describe("una pantalla de visitante: entrar y registrarse", () => {
  it.each([
    ["anonymous", { kind: "render" }],
    ["pass", { kind: "redirect", to: "/inicio" }],
    ["incomplete", { kind: "redirect", to: "/inicio" }],
    ["suspended", { kind: "redirect", to: "/inicio" }],
    // Una cookie que ya no vale no estorba: entrar cierra la sesión que el navegador traía.
    ["closeToRecover", { kind: "render" }],
    ["closeToSignIn", { kind: "render" }],
    // Cuando no se supo, se deja intentar: entrar tiene su propia respuesta de «no disponible».
    ["unavailable", { kind: "render" }],
  ] as const)("%s", (name, expected) => {
    expect(visitorPageStep(check(name))).toEqual(expected);
  });
});

describe("a dónde va quien pasó por la ruta que cierra una sesión rechazada", () => {
  it.each([
    ["recover", { to: "/recuperar", notice: "choose_password" }],
    ["sign_in", { to: "/entrar", notice: null }],
    ["none", { to: "/entrar", notice: null }],
    ["kept", { to: "/inicio", notice: null }],
  ] as const)("%s", (result, expected) => {
    expect(closedSessionRoute(result)).toEqual(expected);
  });

  it("ninguna salida vuelve a la ruta que cierra: no puede dar vueltas sola", () => {
    for (const result of ["recover", "sign_in", "none", "kept"] as const) {
      expect(closedSessionRoute(result).to).not.toContain("/sesion");
    }
  });
});
