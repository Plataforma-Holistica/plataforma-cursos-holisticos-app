import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  captureServerFailure: vi.fn(async (...failures: [Error]) => void failures),
  startServerErrorReporting: vi.fn(),
}));
vi.mock("@/adapters/sentry/server", () => adapter);
vi.mock("@/config/env", () => ({ getEnv: () => ({ APP_ENV: "local" }) }));

import { OperationalFailure, reportFailure } from "./server";

// Un fallo de operación es algo que nadie lanzó pero que alguien tiene que saber (TRD
// §9.2: «se reporta como fallo de operación»; RNF-16). Sale con un código de una lista
// cerrada y un mensaje fijo: nada de lo que se reporta puede traer el dato de una persona.

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  logged.mockRestore();
});

describe("reportFailure", () => {
  it("manda al registro de errores un error con su código y un mensaje fijo", async () => {
    await reportFailure("gate_no_current_text");

    expect(adapter.captureServerFailure).toHaveBeenCalledOnce();
    const failure = adapter.captureServerFailure.mock.calls[0]?.[0];
    expect(failure).toBeInstanceOf(OperationalFailure);
    expect(failure).toMatchObject({ name: "OperationalFailure", code: "gate_no_current_text" });
    expect(failure?.message).toMatch(/texto vigente/);
  });

  it("lo deja también en los registros del servidor, con el código", async () => {
    await reportFailure("throttle_unavailable");
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]?.[0])).toContain("throttle_unavailable");
  });

  it("cada código tiene su mensaje, distinto de los demás y sin llaves ni datos", () => {
    const codes = [
      "gate_no_current_text",
      "gate_unavailable",
      "throttle_unavailable",
      "session_oversized",
      "session_not_noted",
      "session_not_tagged",
      "password_change_unconfirmed",
      "password_change_incomplete",
      "session_not_closed",
      "session_cookie_not_written",
      "sign_in_settle_failed",
      "client_ip_unknown",
      "mail_limits_unavailable",
      "registration_mail_failed",
      "recovery_mail_failed",
      "registration_incomplete",
      "recovery_incomplete",
      "recovery_notice_not_sent",
      "recovery_with_second_factor",
      "legal_text_unavailable",
      "mailbox_proof_unavailable",
      "mailbox_ticket_not_kept",
      "team_unavailable",
      "invitation_not_accepted",
      "invitation_answer_lost",
      "second_factor_not_removed",
    ] as const;
    const messages = codes.map((code) => new OperationalFailure(code).message);
    expect(new Set(messages).size).toBe(codes.length);
    for (const message of messages) {
      expect(message).not.toMatch(/[{}@]|\d{3,}/);
      expect(message).not.toContain("—");
    }
  });

  it("si el registro de errores falla, no tumba a quien reporta", async () => {
    adapter.captureServerFailure.mockRejectedValueOnce(new Error("sin red"));
    await expect(reportFailure("gate_unavailable")).resolves.toBeUndefined();
  });
});
