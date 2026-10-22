import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de PA-68 mínima (las alertas de anomalía; T-208), con los servicios
// simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada respuesta. Lo
// que los servicios hacen de verdad lo prueban `tests/integration/46-alertas.test.ts` y pgTAP.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  const unavailable = () => Promise.resolve<unknown>({ kind: "unavailable" });
  return {
    giveFinanceCode: logged("giveFinanceCode", unavailable),
    reviewAlert: logged("reviewAlert", unavailable),
    decideFraud: logged("decideFraud", unavailable),
    excludeAccount: logged("excludeAccount", unavailable),
    revokeExclusion: logged("revokeExclusion", unavailable),
    leaveNotice: logged("leaveNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/anomalies/anomalies", () => ({
  giveFinanceCode: mocks.giveFinanceCode,
  reviewAlert: mocks.reviewAlert,
  decideFraud: mocks.decideFraud,
  excludeAccount: mocks.excludeAccount,
  revokeExclusion: mocks.revokeExclusion,
}));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { alertsAction, alertsCodeAction } from "@/app/admin/_alertas/actions";
import { alertsButton } from "@/app/admin/_alertas/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const ALERT = "a1e70000-0000-4000-8000-000000000002";
const EXCLUSION = "e0000000-0000-4000-8000-000000000003";
const ACCOUNT = "0123456789ab";
const NO_DRAFTS = { note: undefined, evidence: undefined, reason: undefined, reasonCode: undefined };

const pressed = (value: string, fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.append("do", value);
  for (const [name, text] of Object.entries(fields)) data.append(name, text);
  return data;
};

/** Lo que contesta la siguiente llamada a esa simulación. */
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("alertsAction: los primeros pasos no llaman a nadie", () => {
  it("«Decidir que es fraude», «Excluir» y «Revertir» solo preguntan en su lugar", async () => {
    expect(await alertsAction(IDLE, pressed(alertsButton.askFraud(ALERT)))).toEqual({
      kind: "confirming",
      confirming: { step: "fraud", alert: ALERT },
      problem: null,
      drafts: NO_DRAFTS,
      attempt: 1,
    });
    expect(await alertsAction(IDLE, pressed(alertsButton.askExclusion(ALERT, ACCOUNT)))).toMatchObject({
      kind: "confirming",
      confirming: { step: "exclude", alert: ALERT, account: ACCOUNT },
    });
    expect(await alertsAction(IDLE, pressed(alertsButton.askRevocation(ALERT, EXCLUSION)))).toMatchObject({
      kind: "confirming",
      confirming: { step: "revoke", alert: ALERT, exclusion: EXCLUSION },
    });
    expect(calls.order).toEqual([]);
  });

  it("confirmar sin lo escrito vuelve a preguntar, con lo que falta y lo que sí se escribió", async () => {
    expect(
      await alertsAction({ kind: "idle" }, pressed(alertsButton.exclude(ALERT, ACCOUNT), { reason_code: "other", reason: "  " })),
    ).toEqual({
      kind: "confirming",
      confirming: { step: "exclude", alert: ALERT, account: ACCOUNT },
      problem: "missing_reason",
      drafts: { ...NO_DRAFTS, reason: "  ", reasonCode: "other" },
      attempt: 1,
    });
    expect(await alertsAction(IDLE, pressed(alertsButton.fraud(ALERT)))).toMatchObject({ kind: "confirming", problem: "missing_evidence" });
    expect(await alertsAction(IDLE, pressed(alertsButton.revoke(ALERT, EXCLUSION)))).toMatchObject({ kind: "confirming", problem: "missing_reason" });
    expect(calls.order).toEqual([]);
  });

  it("«Cancelar», o un envío vacío, no llama a nadie", async () => {
    expect(await alertsAction(IDLE, pressed(alertsButton.cancel()))).toEqual(IDLE);
    expect(await alertsAction(IDLE, new FormData())).toEqual(IDLE);
    expect(await alertsAction(IDLE, "no es un formulario" as never)).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it("del estado anterior solo se lee el número de intento", async () => {
    const previous = { kind: "confirming", confirming: { step: "fraud", alert: EXCLUSION }, problem: null, drafts: {}, attempt: 4 } as const;
    expect(await alertsAction(previous, pressed(alertsButton.askFraud(ALERT)))).toMatchObject({ confirming: { alert: ALERT }, attempt: 5 });
  });
});

describe("alertsAction: las decisiones", () => {
  it("revisar: la alerta del botón y la nota; revisada, redirige con el aviso", async () => {
    once("reviewAlert", { kind: "answered", answer: "reviewed" });
    await expect(alertsAction(IDLE, pressed(alertsButton.review(ALERT), { note: "La revisé." }))).rejects.toThrow("redirige a /admin/alertas");
    expect(mocks.reviewAlert).toHaveBeenCalledWith(jar, { alert: ALERT, note: "La revisé." });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "alert_reviewed");
    expect(calls.order).toEqual(["reviewAlert", "leaveNotice", "redirect"]);
  });

  it("decidir fraude: con la evidencia", async () => {
    once("decideFraud", { kind: "answered", answer: "marked_fraud" });
    await expect(alertsAction(IDLE, pressed(alertsButton.fraud(ALERT), { evidence: "Once cuentas." }))).rejects.toThrow("redirige");
    expect(mocks.decideFraud).toHaveBeenCalledWith(jar, { alert: ALERT, evidence: "Once cuentas." });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "fraud_decided");
  });

  it("excluir: la cuenta es la huella del botón, el motivo y lo escrito, tal como llegaron", async () => {
    once("excludeAccount", { kind: "answered", answer: "excluded" });
    await expect(
      alertsAction(IDLE, pressed(alertsButton.exclude(ALERT, ACCOUNT), { reason_code: "test_account", reason: "Es de prueba." })),
    ).rejects.toThrow("redirige");
    expect(mocks.excludeAccount).toHaveBeenCalledWith(jar, { alert: ALERT, account: ACCOUNT, reasonCode: "test_account", reason: "Es de prueba." });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "account_excluded");
  });

  it("revertir: la exclusión del botón y su motivo", async () => {
    once("revokeExclusion", { kind: "answered", answer: "revoked" });
    await expect(alertsAction(IDLE, pressed(alertsButton.revoke(ALERT, EXCLUSION), { reason: "Era un error." }))).rejects.toThrow("redirige");
    expect(mocks.revokeExclusion).toHaveBeenCalledWith(jar, { exclusion: EXCLUSION, reason: "Era un error." });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "exclusion_revoked");
  });

  it("lo que no se hizo se dice con lo escrito, y la página se vuelve a pedir: la lista pudo cambiar", async () => {
    once("excludeAccount", { kind: "answered", answer: "needs_fresh_code" });
    expect(
      await alertsAction(IDLE, pressed(alertsButton.exclude(ALERT, ACCOUNT), { reason_code: "other", reason: "Un motivo." })),
    ).toEqual({ kind: "failed", reason: "needs_code", alert: ALERT, drafts: { ...NO_DRAFTS, reason: "Un motivo.", reasonCode: "other" }, attempt: 1 });
    expect(calls.order).toEqual(["excludeAccount", "refresh"]);
  });

  it("«no se supo» nunca es hecho", async () => {
    once("reviewAlert", { kind: "unknown" });
    expect(await alertsAction(IDLE, pressed(alertsButton.review(ALERT), { note: "Nota." }))).toMatchObject({ kind: "failed", reason: "unknown" });
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });

  it("a quien la guarda no dejó, a la página: decide su guarda", async () => {
    once("revokeExclusion", { kind: "refused" });
    await expect(alertsAction(IDLE, pressed(alertsButton.revoke(ALERT, EXCLUSION), { reason: "Un motivo." }))).rejects.toThrow(
      "redirige a /admin/alertas",
    );
    expect(calls.order).toEqual(["revokeExclusion", "redirect"]);
  });
});

describe("alertsCodeAction", () => {
  it("un código sin forma no llega al servicio", async () => {
    const data = new FormData();
    data.append("code", "12");
    expect(await alertsCodeAction(IDLE, data)).toEqual({ kind: "invalid", problem: "invalid", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("con forma, al servicio de las alertas; verificado, a esta página", async () => {
    once("giveFinanceCode", { kind: "verified" });
    const data = new FormData();
    data.append("code", "123 456");
    await expect(alertsCodeAction(IDLE, data)).rejects.toThrow("redirige a /admin/alertas");
    expect(mocks.giveFinanceCode).toHaveBeenCalledWith(jar, "123 456");
    expect(calls.order).toEqual(["giveFinanceCode", "redirect"]);
  });

  it("un código equivocado se dice", async () => {
    once("giveFinanceCode", { kind: "wrong_code" });
    const data = new FormData();
    data.append("code", "123456");
    expect(await alertsCodeAction(IDLE, data)).toEqual({ kind: "failed", reason: "wrong_code", attempt: 1 });
  });
});
