import { describe, expect, it } from "vitest";

import { type PasswordFlow, type PasswordOutcome, type PasswordSetResult, resolvePasswordOutcome } from "./password-outcome";

// Qué sigue después de pedirle a Auth que fije una contraseña (TRD §9.2, filas
// «Verificación de correo» y «Recuperación»). Para entonces el enlace ya se canjeó: si la
// contraseña se rechaza, el enlace no vuelve. La regla que más importa: la marca de
// contraseña solo se apaga cuando la contraseña quedó fijada de verdad.

// La tabla completa. No hay propiedades: son diez celdas y se escriben todas.
const table: Array<[PasswordFlow, PasswordSetResult, PasswordOutcome]> = [
  ["complete_registration", "ok", { next: "done", claimAccount: true, clearThrottles: false, closeSessions: false }],
  ["complete_registration", "same_password", { next: "done", claimAccount: true, clearThrottles: false, closeSessions: true }],
  ["complete_registration", "weak_password", { next: "recover_instead", claimAccount: false, clearThrottles: false, closeSessions: true }],
  ["complete_registration", "rejected", { next: "recover_instead", claimAccount: false, clearThrottles: false, closeSessions: true }],
  ["complete_registration", "unknown", { next: "outcome_unknown", claimAccount: false, clearThrottles: false, closeSessions: true }],
  ["recovery", "ok", { next: "done", claimAccount: true, clearThrottles: true, closeSessions: true }],
  ["recovery", "same_password", { next: "done", claimAccount: true, clearThrottles: true, closeSessions: true }],
  ["recovery", "weak_password", { next: "request_new_link", claimAccount: false, clearThrottles: false, closeSessions: true }],
  ["recovery", "rejected", { next: "request_new_link", claimAccount: false, clearThrottles: false, closeSessions: true }],
  ["recovery", "unknown", { next: "outcome_unknown", claimAccount: false, clearThrottles: false, closeSessions: true }],
];

describe("resolvePasswordOutcome", () => {
  it.each(table)("al %s, si Auth contesta %s", (flow, result, expected) => {
    expect(resolvePasswordOutcome(flow, result)).toEqual(expected);
  });

  it("la marca solo se apaga cuando la contraseña quedó fijada", () => {
    for (const [flow, result, expected] of table) {
      const fixed = result === "ok" || result === "same_password";
      expect(resolvePasswordOutcome(flow, result).claimAccount, `${flow} / ${result}`).toBe(fixed);
      expect(expected.next === "done").toBe(fixed);
    }
  });

  it("los frenos solo se quitan al recuperar con éxito", () => {
    for (const [flow, result] of table) {
      const outcome = resolvePasswordOutcome(flow, result);
      expect(outcome.clearThrottles, `${flow} / ${result}`).toBe(flow === "recovery" && outcome.next === "done");
    }
  });

  // La única celda en la que no hace falta cerrar sesiones: al completar el registro con
  // éxito, fijar la contraseña por la API de administración ya las borró todas.
  it("las sesiones se cierran siempre, salvo cuando Auth ya las borró al fijar la contraseña", () => {
    for (const [flow, result] of table) {
      const outcome = resolvePasswordOutcome(flow, result);
      expect(outcome.closeSessions, `${flow} / ${result}`).toBe(!(flow === "complete_registration" && result === "ok"));
    }
  });
});
