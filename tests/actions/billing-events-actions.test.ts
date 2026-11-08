import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de PA-84 (la cola de los avisos de cobro; T-303, tercera solicitud), con los servicios simulados: qué le pasa cada una a su servicio, en
// qué orden, y qué hace con cada respuesta. Lo que los servicios hacen de verdad lo prueban `tests/integration/114-cola-de-avisos.test.ts` y pgTAP 86.

const calls = vi.hoisted(() => ({ order: [] as string[], after: [] as (() => Promise<unknown>)[] }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      return result();
    });
  const unavailable = () => Promise.resolve<unknown>({ kind: "unavailable" });
  return {
    giveBillingCode: logged("giveBillingCode", unavailable),
    retryBillingEvent: logged("retryBillingEvent", unavailable),
    resolveBillingEvent: logged("resolveBillingEvent", unavailable),
    sendQueuedMail: logged("sendQueuedMail", () => Promise.resolve()),
    leaveNotice: logged("leaveNotice", () => undefined),
    clearNotice: vi.fn(),
    refresh: logged("refresh", () => undefined),
    after: vi.fn((work: () => Promise<unknown>) => {
      calls.order.push("after");
      calls.after.push(work);
    }),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/app/_lib/mail-requests", () => ({ sendQueuedMail: mocks.sendQueuedMail }));
vi.mock("@/services/billing/billing", () => ({
  giveBillingCode: mocks.giveBillingCode,
  retryBillingEvent: mocks.retryBillingEvent,
  resolveBillingEvent: mocks.resolveBillingEvent,
}));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice, clearNotice: mocks.clearNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
vi.mock("next/server", () => ({ after: mocks.after }));

import { billingCodeAction, billingEventsAction } from "@/app/admin/_avisos/actions";
import { billingButton } from "@/app/admin/_avisos/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const EVENT = "e0000000-0000-4000-8000-000000000001";

const pressed = (value: string, fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.append("do", value);
  for (const [name, text] of Object.entries(fields)) data.append(name, text);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.order.length = 0;
  calls.after.length = 0;
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("reintentar", () => {
  it("le pasa al servicio el aviso y la revisión del botón; procesado, manda el correo encolado y vuelve con su aviso", async () => {
    mocks.retryBillingEvent.mockResolvedValueOnce({ kind: "ran", run: { kind: "processed" } });
    await expect(billingEventsAction(IDLE, pressed(billingButton.retry(EVENT, 4)))).rejects.toThrow("redirige a /admin/avisos-cobro");
    expect(mocks.retryBillingEvent).toHaveBeenCalledWith(jar, { event: EVENT, revision: "4" });
    expect(calls.order).toEqual(["sendQueuedMail", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "billing_event_processed");
  });

  it("lo que pasa del tope termina detrás de la respuesta, y el correo sale después", async () => {
    let finish = () => undefined as void;
    const rest = new Promise<void>((resolve) => (finish = resolve));
    mocks.retryBillingEvent.mockResolvedValueOnce({ kind: "ran", run: { kind: "still_pending" }, rest });
    await expect(billingEventsAction(IDLE, pressed(billingButton.retry(EVENT, 4)))).rejects.toThrow("redirige");
    expect(calls.order).toEqual(["after", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "billing_event_on_its_way");
    const later = calls.after[0]!();
    finish();
    await later;
    expect(mocks.sendQueuedMail).toHaveBeenCalledTimes(1);
  });

  it("si volvió a fallar, se queda, vuelve a pedir la página y dice el código", async () => {
    mocks.retryBillingEvent.mockResolvedValueOnce({ kind: "ran", run: { kind: "failed", code: "unknown_account" } });
    expect(await billingEventsAction(IDLE, pressed(billingButton.retry(EVENT, 4)))).toEqual({
      kind: "failed",
      reason: "failed_again",
      code: "unknown_account",
      event: EVENT,
      note: undefined,
      attempt: 1,
    });
    expect(calls.order).toEqual(["sendQueuedMail", "refresh"]);
  });

  it("si la base no lo reabrió, no manda correo", async () => {
    mocks.retryBillingEvent.mockResolvedValueOnce({ kind: "answered", answer: "changed" });
    expect(await billingEventsAction(IDLE, pressed(billingButton.retry(EVENT, 4)))).toMatchObject({ kind: "failed", reason: "changed" });
    expect(calls.order).toEqual(["refresh"]);
  });
});

describe("resolver a mano", () => {
  it("el primer paso pregunta en su fila sin llamar a nadie", async () => {
    expect(await billingEventsAction(IDLE, pressed(billingButton.askResolve(EVENT, 4)))).toEqual({
      kind: "confirming",
      asked: { event: EVENT, revision: "4", problem: null },
      note: undefined,
      attempt: 1,
    });
    expect(calls.order).toEqual([]);
  });

  it("confirmar sin nota vuelve a preguntar, con lo que falta", async () => {
    expect(await billingEventsAction(IDLE, pressed(billingButton.resolve(EVENT, 4), { note: "  " }))).toMatchObject({
      kind: "confirming",
      asked: { problem: "missing_note" },
    });
    expect(calls.order).toEqual([]);
  });

  it("con su nota, la pasa al servicio y vuelve con su aviso", async () => {
    mocks.resolveBillingEvent.mockResolvedValueOnce({ kind: "answered", answer: "resolved" });
    await expect(billingEventsAction(IDLE, pressed(billingButton.resolve(EVENT, 4), { note: "Factura de prueba" }))).rejects.toThrow("redirige");
    expect(mocks.resolveBillingEvent).toHaveBeenCalledWith(jar, { event: EVENT, revision: "4", note: "Factura de prueba" });
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "billing_event_resolved");
  });

  it("si falla, la nota viaja en el estado para no perderse", async () => {
    mocks.resolveBillingEvent.mockResolvedValueOnce({ kind: "answered", answer: "changed" });
    expect(await billingEventsAction(IDLE, pressed(billingButton.resolve(EVENT, 4), { note: "Factura de prueba" }))).toMatchObject({
      kind: "failed",
      reason: "changed",
      note: "Factura de prueba",
    });
  });
});

describe("lo demás", () => {
  it("un envío sin intención no llama a nadie", async () => {
    expect(await billingEventsAction(IDLE, new FormData())).toEqual(IDLE);
    expect(await billingEventsAction(IDLE, pressed(billingButton.cancel()))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it("un código sin forma no llega al servicio", async () => {
    const form = new FormData();
    form.append("code", "12");
    expect(await billingCodeAction(IDLE, form)).toMatchObject({ kind: "invalid" });
    expect(mocks.giveBillingCode).not.toHaveBeenCalled();
  });
});
