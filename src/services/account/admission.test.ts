import { describe, expect, it } from "vitest";

import type { GateResult } from "@/domain/access/session-gate";

import {
  authRefusal,
  decideAdmission,
  gateViewOf,
  isSessionId,
  refusalOf,
  sessionCheckOf,
  type GateView,
  type NoteState,
} from "./admission";

// Qué hace la aplicación con lo que decidieron la guarda y la base (TRD §9.2, filas «Freno
// progresivo» y «Lo que entra sin pasar por el formulario»). Son tablas: cada celda dice
// qué ve la persona, cómo se cierra el intento en el freno, si la sesión se queda, y si es
// un fallo de operación.

const missing = { name: true, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" as const }] };
const incomplete: GateView = { kind: "incomplete", variant: "complete_account", missing };
const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1" as const, sessionId: "s", issuedAt: 0 };

describe("gateViewOf: lo que decidió el dominio, como lo usa el servicio", () => {
  it.each<[string, GateResult, GateView]>([
    ["pase", { outcome: "pass" }, { kind: "pass" }],
    ["cuenta suspendida", { outcome: "blocked", reason: "suspended" }, { kind: "suspended" }],
    ["sin perfil", { outcome: "blocked", reason: "no_profile" }, { kind: "gone" }],
    ["cuenta eliminada", { outcome: "blocked", reason: "deleted" }, { kind: "gone" }],
    ["marca de contraseña prendida", { outcome: "password_reset_required" }, { kind: "must_recover" }],
    [
      "sin texto vigente",
      { outcome: "unavailable", reason: "no_current_text", docTypes: ["terms"] },
      { kind: "unavailable", reason: "no_current_text" },
    ],
    [
      "hechos incompletos",
      { outcome: "unavailable", reason: "facts_incomplete", docTypes: [] },
      { kind: "unavailable", reason: "facts_incomplete" },
    ],
    ["le falta algo", { outcome: "incomplete", variant: "complete_account", missing }, incomplete],
  ])("%s", (_name, result, view) => {
    expect(gateViewOf(result)).toEqual(view);
  });
});

describe("decideAdmission: una entrada que Auth aceptó", () => {
  const notes: (NoteState | null)[] = ["noted", "stale", "skewed", "unclaimed", "gone", "ineligible", null];

  it("pasa y queda anotada: entra, y el intento se cierra como bueno", () => {
    expect(decideAdmission({ kind: "pass" }, "noted")).toEqual({
      result: { kind: "entered", pending: null },
      outcome: "success",
      admit: true,
      report: null,
    });
  });

  it("le falta algo y queda anotada: entra, y se le dice qué le falta", () => {
    expect(decideAdmission(incomplete, "noted")).toEqual({
      result: { kind: "entered", pending: { variant: "complete_account", missing } },
      outcome: "success",
      admit: true,
      report: null,
    });
  });

  // La entrada empezó antes del último cambio de contraseña: la aceptó Auth con una
  // contraseña que ya no vale. Para quien la intenta es una contraseña equivocada.
  it.each([{ kind: "pass" } as GateView, incomplete])("una entrada vieja no entra y cuenta como fallo (%j)", (view) => {
    expect(decideAdmission(view, "stale")).toEqual({
      result: { kind: "invalid_credentials" },
      outcome: "failure",
      admit: false,
      report: null,
    });
  });

  it("sin fecha de reclamo no entra: tiene que recuperar", () => {
    expect(decideAdmission({ kind: "pass" }, "unclaimed")).toEqual({
      result: { kind: "must_recover" },
      outcome: "failure",
      admit: false,
      report: null,
    });
  });

  it.each<NoteState | null>(["gone", "ineligible", "skewed", null])(
    "si la sesión no se pudo anotar (%s), no entra, no se supo, y se reporta",
    (noted) => {
      expect(decideAdmission({ kind: "pass" }, noted)).toEqual({
        result: { kind: "unavailable" },
        outcome: "unknown",
        admit: false,
        report: "session_not_noted",
      });
    },
  );

  it("una respuesta de la base que no está en la lista tampoco anota: no se supo", () => {
    expect(decideAdmission({ kind: "pass" }, "algo-nuevo" as NoteState)).toMatchObject({
      result: { kind: "unavailable" },
      outcome: "unknown",
      admit: false,
    });
  });

  // Una contraseña correcta en una cuenta con la marca prendida se cierra como fallo: si
  // no, quien dio de alta un correo ajeno quedaría como dispositivo de confianza.
  it.each(notes)("con la marca prendida va a recuperar y cuenta como fallo (anotada: %s)", (noted) => {
    expect(decideAdmission({ kind: "must_recover" }, noted)).toEqual({
      result: { kind: "must_recover" },
      outcome: "failure",
      admit: false,
      report: null,
    });
  });

  // Probó la contraseña y es su cuenta. Como fallo, se frenaría sola por leer el aviso.
  it.each(notes)("suspendida: ve su aviso, sin sesión, y cuenta como entrada correcta (anotada: %s)", (noted) => {
    expect(decideAdmission({ kind: "suspended" }, noted)).toEqual({
      result: { kind: "suspended" },
      outcome: "success",
      admit: false,
      report: null,
    });
  });

  it.each(notes)("sin perfil o eliminada: lo mismo que una contraseña equivocada (anotada: %s)", (noted) => {
    expect(decideAdmission({ kind: "gone" }, noted)).toEqual({
      result: { kind: "invalid_credentials" },
      outcome: "failure",
      admit: false,
      report: null,
    });
  });

  it.each([
    ["no_current_text", "gate_no_current_text"],
    ["facts_incomplete", "gate_unavailable"],
  ] as const)("guarda sin poder decidir (%s): no entra nadie, no se supo, y se reporta", (reason, report) => {
    for (const noted of notes) {
      expect(decideAdmission({ kind: "unavailable", reason }, noted)).toEqual({
        result: { kind: "unavailable" },
        outcome: "unknown",
        admit: false,
        report,
      });
    }
  });

  it("solo se admite una sesión anotada sobre una cuenta que pasa o a la que le falta algo", () => {
    const views: GateView[] = [
      { kind: "pass" },
      incomplete,
      { kind: "suspended" },
      { kind: "must_recover" },
      { kind: "gone" },
      { kind: "unavailable", reason: "no_current_text" },
      { kind: "unavailable", reason: "facts_incomplete" },
    ];
    for (const view of views) {
      for (const noted of notes) {
        const admitted = decideAdmission(view, noted).admit;
        expect(admitted).toBe((view.kind === "pass" || view.kind === "incomplete") && noted === "noted");
        if (admitted) expect(decideAdmission(view, noted).outcome).toBe("success");
      }
    }
  });
});

describe("sessionCheckOf: una entrada con sesión", () => {
  it.each(["unknown", "", "algo-que-la-base-no-dice"])(
    "una respuesta que no dice si la sesión vale (%j) no cierra la sesión de nadie: no se supo, y se reporta",
    (recognition) => {
      for (const view of [{ kind: "pass" } as GateView, { kind: "suspended" } as GateView, null]) {
        expect(sessionCheckOf(recognition, view, claims)).toEqual({
          check: { kind: "unavailable" },
          report: "gate_unavailable",
        });
      }
    },
  );

  it.each(["not_noted", "gone"])(
    "una sesión que la aplicación no reconoce (%s) se cierra, sea de la cuenta que sea",
    (recognition) => {
      for (const view of [{ kind: "pass" } as GateView, { kind: "suspended" } as GateView, null]) {
        expect(sessionCheckOf(recognition, view, claims)).toEqual({
          check: { kind: "must_sign_out", then: "sign_in" },
          report: null,
        });
      }
    },
  );

  it("reconocida y completa: pasa, con sus claims", () => {
    expect(sessionCheckOf("recognized", { kind: "pass" }, claims)).toEqual({
      check: { kind: "pass", claims },
      report: null,
    });
  });

  it("reconocida y le falta algo: se le dice qué", () => {
    expect(sessionCheckOf("recognized", incomplete, claims)).toEqual({
      check: { kind: "incomplete", claims, variant: "complete_account", missing },
      report: null,
    });
  });

  it("reconocida y suspendida: ve su aviso", () => {
    expect(sessionCheckOf("recognized", { kind: "suspended" }, claims)).toEqual({
      check: { kind: "suspended" },
      report: null,
    });
  });

  it("reconocida y con la marca prendida: se cierra y va a recuperar", () => {
    expect(sessionCheckOf("recognized", { kind: "must_recover" }, claims)).toEqual({
      check: { kind: "must_sign_out", then: "recover" },
      report: null,
    });
  });

  it("reconocida y sin perfil: se cierra", () => {
    expect(sessionCheckOf("recognized", { kind: "gone" }, claims)).toEqual({
      check: { kind: "must_sign_out", then: "sign_in" },
      report: null,
    });
  });

  it.each([
    ["no_current_text", "gate_no_current_text"],
    ["facts_incomplete", "gate_unavailable"],
  ] as const)("reconocida y la guarda no puede decidir (%s): no se supo, y se reporta", (reason, report) => {
    expect(sessionCheckOf("recognized", { kind: "unavailable", reason }, claims)).toEqual({
      check: { kind: "unavailable" },
      report,
    });
  });

  it("reconocida pero sin lo que decide la guarda: no se supo, y se reporta", () => {
    expect(sessionCheckOf("recognized", null, claims)).toEqual({
      check: { kind: "unavailable" },
      report: "gate_unavailable",
    });
  });
});

describe("refusalOf: un intento que el freno no deja seguir", () => {
  const retryAt = new Date("2026-10-11T06:00:00.000Z");

  it("frenado: dice a qué hora se puede volver a intentar", () => {
    expect(refusalOf({ proceed: false, reason: "throttled", retryAt })).toEqual({
      result: { kind: "throttled", retryAt },
      report: null,
    });
  });

  it.each(["ip_hourly_cap", "account_hourly_cap"] as const)("tope por hora (%s): sin hora, y sin decir cuál", (reason) => {
    expect(refusalOf({ proceed: false, reason })).toEqual({ result: { kind: "capped" }, report: null });
  });

  it("parámetros o cuentas sin sentido: no pasa nadie, no se supo, y se reporta", () => {
    expect(refusalOf({ proceed: false, reason: "invalid_input" })).toEqual({
      result: { kind: "unavailable" },
      report: "throttle_unavailable",
    });
  });
});

describe("authRefusal: Auth no dio sesión", () => {
  // Auth distingue los tres. Mostrarlos delataría el estado de la cuenta.
  it.each(["invalid_credentials", "email_not_confirmed", "banned"] as const)(
    "%s: un solo mensaje, y cuenta como fallo",
    (reason) => {
      expect(authRefusal(reason)).toEqual({
        result: { kind: "invalid_credentials" },
        outcome: "failure",
        admit: false,
        report: null,
      });
    },
  );

  it.each(["rate_limited", "unknown"] as const)("%s: no se supo, y no es un fallo de quien intenta", (reason) => {
    expect(authRefusal(reason)).toEqual({
      result: { kind: "unavailable" },
      outcome: "unknown",
      admit: false,
      report: null,
    });
  });

  it("la sesión no cabe en la cookie: la contraseña era buena, va a recuperar y se reporta", () => {
    expect(authRefusal("oversized_session")).toEqual({
      result: { kind: "must_recover" },
      outcome: "unknown",
      admit: false,
      report: "session_oversized",
    });
  });

  it("un motivo que la lista no conoce es «no se supo»", () => {
    expect(authRefusal("otro" as never)).toMatchObject({ result: { kind: "unavailable" }, outcome: "unknown" });
  });
});

describe("isSessionId: un identificador de sesión con forma de serlo", () => {
  it.each(["5e550000-0000-4000-8000-000000000001", "5E550000-0000-4000-8000-00000000ABCD"])("%s lo es", (value) => {
    expect(isSessionId(value)).toBe(true);
  });

  it.each([
    null,
    "",
    "s",
    "5e550000-0000-4000-8000-00000000000",
    "5e550000-0000-4000-8000-0000000000011",
    "5e550000000040008000000000000001",
    " 5e550000-0000-4000-8000-000000000001",
    "5e550000-0000-4000-8000-000000000001\n",
    "5e550000-0000-4000-8000-00000000000g",
    "'; select 1; --",
  ])("%j no lo es", (value) => {
    expect(isSessionId(value)).toBe(false);
  });
});
