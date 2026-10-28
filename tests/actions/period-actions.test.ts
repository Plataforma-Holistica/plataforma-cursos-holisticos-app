import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de PA-79 y PA-80 (el panel de un periodo, y su ensayo y cierre; T-605), con
// los servicios simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada
// respuesta. Lo que los servicios hacen de verdad lo prueban `tests/integration/56-periodos.test.ts` y
// pgTAP.

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
    givePeriodsCode: logged("givePeriodsCode", unavailable),
    requestRollup: logged("requestRollup", unavailable),
    rehearse: logged("rehearse", unavailable),
    closePeriod: logged("closePeriod", unavailable),
    downloadExport: logged("downloadExport", unavailable),
    leaveNotice: logged("leaveNotice", () => undefined),
    // Se borra siempre, también al preguntar: no se anota en el orden de lo que se llamó.
    clearNotice: vi.fn(),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/periods/periods", () => ({
  givePeriodsCode: mocks.givePeriodsCode,
  requestRollup: mocks.requestRollup,
  rehearse: mocks.rehearse,
  closePeriod: mocks.closePeriod,
  downloadExport: mocks.downloadExport,
}));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice, clearNotice: mocks.clearNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { closeAction, downloadAction, panelAction, periodCodeAction } from "@/app/admin/_periodos/actions";
import { csvHref, periodsButton } from "@/app/admin/_periodos/outcomes";
import { periodClosePath, periodPath, ROUTES } from "@/services/account/navigation";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const PERIOD = 202710;
const RUN = "c1000000-0000-4000-8000-000000000001";

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

describe("periodCodeAction", () => {
  it("un código sin forma no llega al servicio", async () => {
    const form = new FormData();
    form.append("code", "12");
    expect(await periodCodeAction({ period: PERIOD, page: "close" }, IDLE, form)).toMatchObject({ kind: "invalid", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("verificado: a la página de donde se dio", async () => {
    once("givePeriodsCode", Promise.resolve({ kind: "verified" }));
    const form = new FormData();
    form.append("code", "123456");
    await expect(periodCodeAction({ period: PERIOD, page: "close" }, IDLE, form)).rejects.toThrow(`redirige a ${periodClosePath(PERIOD)}`);
    expect(mocks.redirect).toHaveBeenCalledWith(periodClosePath(PERIOD));
  });

  it("con una página armada a mano: a la lista", async () => {
    once("givePeriodsCode", Promise.resolve({ kind: "verified" }));
    const form = new FormData();
    form.append("code", "123456");
    await expect(periodCodeAction("https://otro.example", IDLE, form)).rejects.toThrow(`redirige a ${ROUTES.periods}`);
  });

  it("un código equivocado se dice en el bloque", async () => {
    once("givePeriodsCode", Promise.resolve({ kind: "wrong_code" }));
    const form = new FormData();
    form.append("code", "123456");
    expect(await periodCodeAction({ period: PERIOD, page: "panel" }, IDLE, form)).toEqual({ kind: "failed", reason: "wrong_code", attempt: 1 });
  });
});

describe("panelAction", () => {
  it("pedido: al panel con su aviso, sin volver a pedir la página", async () => {
    once("requestRollup", Promise.resolve({ kind: "answered", answer: "requested" }));
    await expect(panelAction(IDLE, pressed(periodsButton.rollup(PERIOD)))).rejects.toThrow(`redirige a ${periodPath(PERIOD)}`);
    expect(mocks.requestRollup).toHaveBeenCalledWith(jar, { period: PERIOD });
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "rollup_requested");
    expect(calls.order).toEqual(["requestRollup", "leaveNotice", "redirect"]);
    expect(mocks.clearNotice).toHaveBeenCalledTimes(1);
  });

  it("lo que no sale bien vuelve a pedir la página y se dice", async () => {
    once("requestRollup", Promise.resolve({ kind: "answered", answer: "not_rollable" }));
    expect(await panelAction(IDLE, pressed(periodsButton.rollup(PERIOD)))).toEqual({ kind: "failed", reason: "not_rollable", attempt: 1 });
    expect(calls.order).toEqual(["requestRollup", "refresh"]);
  });

  it("otro botón, o ninguno, no llama a nadie", async () => {
    expect(await panelAction(IDLE, pressed(periodsButton.rehearse(PERIOD)))).toEqual(IDLE);
    expect(await panelAction(IDLE, new FormData())).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });
});

describe("closeAction", () => {
  it("«Cerrar periodo» solo abre el diálogo, sin llamar a nadie", async () => {
    expect(await closeAction(IDLE, pressed(periodsButton.askClose(PERIOD, RUN)))).toEqual({ kind: "confirming", period: PERIOD, run: RUN, missingUnderstood: false, attempt: 1 });
    expect(calls.order).toEqual([]);
    expect(mocks.clearNotice).toHaveBeenCalledTimes(1);
  });

  it("confirmar sin marcar la casilla vuelve a preguntar, sin llamar a nadie", async () => {
    expect(await closeAction(IDLE, pressed(periodsButton.close(PERIOD, RUN)))).toEqual({ kind: "confirming", period: PERIOD, run: RUN, missingUnderstood: true, attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("cancelar cierra el diálogo", async () => {
    expect(await closeAction({ kind: "confirming", period: PERIOD, run: RUN, missingUnderstood: false, attempt: 1 }, pressed(periodsButton.cancel()))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it("confirmado: cierra y vuelve al cierre con su aviso", async () => {
    once("closePeriod", Promise.resolve({ kind: "answered", answer: "closed" }));
    await expect(closeAction(IDLE, pressed(periodsButton.close(PERIOD, RUN), { understood: "yes" }))).rejects.toThrow(`redirige a ${periodClosePath(PERIOD)}`);
    expect(mocks.closePeriod).toHaveBeenCalledWith(jar, { period: PERIOD, run: RUN });
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "period_closed");
  });

  it("una precondición que falta, la suma que no cuadra o no se supo: se dice, y la página se vuelve a pedir", async () => {
    once("closePeriod", Promise.resolve({ kind: "answered", answer: "rehearsal_stale" }));
    expect(await closeAction(IDLE, pressed(periodsButton.close(PERIOD, RUN), { understood: "yes" }))).toEqual({
      kind: "failed",
      reason: "rehearsal_stale",
      step: "close",
      attempt: 1,
    });
    once("closePeriod", Promise.resolve({ kind: "unbalanced" }));
    expect(await closeAction(IDLE, pressed(periodsButton.close(PERIOD, RUN), { understood: "yes" }))).toMatchObject({ reason: "unbalanced" });
    once("closePeriod", Promise.resolve({ kind: "unknown" }));
    expect(await closeAction(IDLE, pressed(periodsButton.close(PERIOD, RUN), { understood: "yes" }))).toMatchObject({ reason: "unknown" });
    expect(calls.order).toEqual(["closePeriod", "refresh", "closePeriod", "refresh", "closePeriod", "refresh"]);
  });

  it("ensayar: ensayado, al cierre con su aviso; demasiado pronto, se dice", async () => {
    once("rehearse", Promise.resolve({ kind: "answered", answer: "rehearsed" }));
    await expect(closeAction(IDLE, pressed(periodsButton.rehearse(PERIOD)))).rejects.toThrow(`redirige a ${periodClosePath(PERIOD)}`);
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "period_rehearsed");
    once("rehearse", Promise.resolve({ kind: "answered", answer: "too_soon" }));
    expect(await closeAction(IDLE, pressed(periodsButton.rehearse(PERIOD)))).toEqual({ kind: "failed", reason: "too_soon", step: "rehearse", attempt: 1 });
  });

  it("pedir el recálculo o descargar desde aquí no es nada", async () => {
    expect(await closeAction(IDLE, pressed(periodsButton.rollup(PERIOD)))).toEqual(IDLE);
    expect(await closeAction(IDLE, pressed(periodsButton.download(RUN)))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });
});

describe("downloadAction", () => {
  it("el archivo vuelve como dirección de datos, en su propio estado, sin volver a pedir la página", async () => {
    once("downloadExport", Promise.resolve({ kind: "file", file: { filename: "cierre-2027-10.csv", content: "x", rows: 1, sha256: "ab".repeat(32) } }));
    expect(await downloadAction(PERIOD, IDLE, pressed(periodsButton.download(RUN)))).toEqual({
      kind: "file",
      filename: "cierre-2027-10.csv",
      rows: 1,
      href: csvHref("x"),
      attempt: 1,
    });
    expect(mocks.downloadExport).toHaveBeenCalledWith(jar, { run: RUN });
    expect(calls.order).toEqual(["downloadExport"]);
  });

  it("sin el código reciente se dice", async () => {
    once("downloadExport", Promise.resolve({ kind: "answered", answer: "needs_fresh_code" }));
    expect(await downloadAction(PERIOD, IDLE, pressed(periodsButton.download(RUN)))).toEqual({ kind: "failed", reason: "needs_code", attempt: 1 });
  });

  it("a quien la guarda no deja: al cierre; con un periodo armado a mano, a la lista", async () => {
    once("downloadExport", Promise.resolve({ kind: "refused" }));
    await expect(downloadAction(PERIOD, IDLE, pressed(periodsButton.download(RUN)))).rejects.toThrow(`redirige a ${periodClosePath(PERIOD)}`);
    await expect(downloadAction("202713", IDLE, pressed(periodsButton.download(RUN)))).rejects.toThrow(`redirige a ${ROUTES.periods}`);
  });

  it("otro botón no es nada", async () => {
    expect(await downloadAction(PERIOD, IDLE, pressed(periodsButton.close(PERIOD, RUN)))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });
});
