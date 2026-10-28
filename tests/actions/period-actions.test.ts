import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de PA-79, PA-80 y PA-81 (el panel de un periodo, su ensayo y cierre, y sus
// liquidaciones; T-605), con
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
    releasePayouts: logged("releasePayouts", unavailable),
    holdPayout: logged("holdPayout", unavailable),
    unholdPayout: logged("unholdPayout", unavailable),
    confirmFounderBonus: logged("confirmFounderBonus", unavailable),
    voidFounderBonus: logged("voidFounderBonus", unavailable),
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
  releasePayouts: mocks.releasePayouts,
  holdPayout: mocks.holdPayout,
  unholdPayout: mocks.unholdPayout,
  confirmFounderBonus: mocks.confirmFounderBonus,
  voidFounderBonus: mocks.voidFounderBonus,
}));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice, clearNotice: mocks.clearNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { closeAction, downloadAction, panelAction, payoutsAction, periodCodeAction } from "@/app/admin/_periodos/actions";
import { csvHref, periodsButton } from "@/app/admin/_periodos/outcomes";
import { payoutsButton } from "@/app/admin/_periodos/payouts-outcomes";
import { periodClosePath, periodPath, periodPayoutsPath, ROUTES } from "@/services/account/navigation";

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

describe("payoutsAction (PA-81)", () => {
  const SEEN = "ab".repeat(32);
  const PAYOUT = "d1000000-0000-4000-8000-000000000001";
  const BONUS = "e1000000-0000-4000-8000-000000000001";
  const PAGE = periodPayoutsPath(PERIOD);

  it("el primer paso de liberar, retener, soltar y anular solo pregunta, sin llamar a nadie", async () => {
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.askRelease(PERIOD, SEEN)))).toEqual({
      kind: "asking",
      ask: { what: "release", seen: SEEN },
      missing: null,
      attempt: 1,
    });
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.askHold(PAYOUT, "calculated")))).toMatchObject({ ask: { what: "hold", payout: PAYOUT, status: "calculated" } });
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.askUnhold(PAYOUT, SEEN)))).toMatchObject({ ask: { what: "unhold", payout: PAYOUT, seen: SEEN } });
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.askVoid(BONUS)))).toMatchObject({ ask: { what: "void", bonus: BONUS } });
    expect(calls.order).toEqual([]);
  });

  it("confirmar sin la casilla, o sin el motivo, vuelve a preguntar sin llamar a nadie", async () => {
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.release(PERIOD, SEEN)))).toMatchObject({ kind: "asking", missing: "understood" });
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.unhold(PAYOUT, SEEN, true)))).toMatchObject({ kind: "asking", missing: "understood" });
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.hold(PAYOUT, "calculated"), { reason: "   " }))).toMatchObject({ kind: "asking", missing: "reason" });
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.void(BONUS)))).toMatchObject({ kind: "asking", missing: "reason" });
    expect(calls.order).toEqual([]);
  });

  it("liberar con la casilla: con la huella vista, y vuelve a la página con su aviso", async () => {
    once("releasePayouts", Promise.resolve({ kind: "answered", answer: "released", blockingPeriod: null, periodStatus: "closed" }));
    await expect(payoutsAction(PERIOD, IDLE, pressed(payoutsButton.release(PERIOD, SEEN), { understood: "yes" }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.releasePayouts).toHaveBeenCalledWith(jar, { period: PERIOD, seen: SEEN });
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "payouts_released");
  });

  it("retener, soltar, confirmar y anular le pasan al servicio lo que se vio y lo escrito", async () => {
    once("holdPayout", Promise.resolve({ kind: "answered", answer: "held", status: null }));
    await expect(payoutsAction(PERIOD, IDLE, pressed(payoutsButton.hold(PAYOUT, "awaiting_invoice"), { reason: " Se revisa. " }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.holdPayout).toHaveBeenCalledWith(jar, { payout: PAYOUT, reason: "Se revisa.", seen: "awaiting_invoice" });
    // Soltar una que no libera no pide la casilla.
    once("unholdPayout", Promise.resolve({ kind: "answered", answer: "released_from_hold", to: "awaiting_invoice" }));
    await expect(payoutsAction(PERIOD, IDLE, pressed(payoutsButton.unhold(PAYOUT, SEEN, false), { note: "Bien." }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.unholdPayout).toHaveBeenCalledWith(jar, { payout: PAYOUT, note: "Bien.", seen: SEEN });
    once("confirmFounderBonus", Promise.resolve({ kind: "answered", answer: "confirmed", status: null }));
    await expect(payoutsAction(PERIOD, IDLE, pressed(payoutsButton.confirmBonus(BONUS)))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.confirmFounderBonus).toHaveBeenCalledWith(jar, { bonus: BONUS });
    once("voidFounderBonus", Promise.resolve({ kind: "answered", answer: "voided" }));
    await expect(payoutsAction(PERIOD, IDLE, pressed(payoutsButton.void(BONUS), { reason: "No aplica." }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.voidFounderBonus).toHaveBeenCalledWith(jar, { period: PERIOD, bonus: BONUS, reason: "No aplica." });
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "payouts_updated");
  });

  it("lo que no sale bien se dice con su detalle, y la página se vuelve a pedir", async () => {
    once("releasePayouts", Promise.resolve({ kind: "answered", answer: "previous_not_released", blockingPeriod: 202709, periodStatus: null }));
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.release(PERIOD, SEEN), { understood: "yes" }))).toEqual({
      kind: "failed",
      reason: "previous_not_released",
      detail: { period: 202709 },
      attempt: 1,
    });
    once("releasePayouts", Promise.resolve({ kind: "not_enabled" }));
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.release(PERIOD, SEEN), { understood: "yes" }))).toEqual({ kind: "failed", reason: "not_enabled", attempt: 1 });
    expect(calls.order).toEqual(["releasePayouts", "refresh", "releasePayouts", "refresh"]);
  });

  it("con un periodo armado a mano: a la lista, sin llamar a nadie; cancelar u otro botón no es nada", async () => {
    await expect(payoutsAction("202710", IDLE, pressed(payoutsButton.release(PERIOD, SEEN), { understood: "yes" }))).rejects.toThrow(`redirige a ${ROUTES.periods}`);
    expect(mocks.releasePayouts).not.toHaveBeenCalled();
    expect(await payoutsAction(PERIOD, IDLE, pressed(payoutsButton.cancel()))).toEqual(IDLE);
    expect(await payoutsAction(PERIOD, IDLE, pressed(periodsButton.rehearse(PERIOD)))).toEqual(IDLE);
    expect(calls.order).toEqual(["redirect"]);
  });
});
