import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción del CSV de PA-47 (T-604, cuarta solicitud), con el servicio simulado: qué le pasa al servicio y qué hace con cada respuesta. Lo que el
// servicio y la base hacen de verdad lo prueban las pruebas de base y de integración del reporte.

const mocks = vi.hoisted(() => ({
  payoutReportCsv: vi.fn(),
  leaveFor: vi.fn((_jar: unknown, outcome: { to: string }) => {
    throw new Error(`sale a ${outcome.to}`);
  }),
  cookieJar: vi.fn(() => Promise.resolve({ jar: true })),
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/app/(cuenta)/_lib/exit", () => ({ leaveFor: mocks.leaveFor }));
vi.mock("@/services/teachers/payout-report-data", () => ({ payoutReportCsv: mocks.payoutReportCsv }));

const { payoutCsvAction } = await import("@/app/portal/_pagos/actions");
const { csvButton, csvHref } = await import("@/app/portal/_pagos/outcomes");
const { signInPath, ROUTES } = await import("@/services/account/navigation");

const JAR = { jar: true };
const IDLE = { kind: "idle" } as const;
const PAGE = "/portal/pagos/2031-02";

const pressed = (value: string) => {
  const data = new FormData();
  data.append("do", value);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("payoutCsvAction", () => {
  it("un envío vacío o con un periodo sin forma no llama a nadie", async () => {
    expect(await payoutCsvAction(IDLE, new FormData())).toEqual(IDLE);
    expect(await payoutCsvAction(IDLE, pressed("csv:2031-13"))).toEqual(IDLE);
    expect(await payoutCsvAction(IDLE, pressed("otra:2031-02"))).toEqual(IDLE);
    expect(mocks.payoutReportCsv).not.toHaveBeenCalled();
  });

  it("le pasa al servicio el tarro y el periodo; el archivo vuelve como dirección de datos, con su intento", async () => {
    mocks.payoutReportCsv.mockResolvedValueOnce({ kind: "csv", fileName: "reporte-2031-02.csv", text: "﻿a,b\r\n" });
    expect(await payoutCsvAction(IDLE, pressed(csvButton("2031-02")))).toEqual({
      kind: "file",
      fileName: "reporte-2031-02.csv",
      href: csvHref("﻿a,b\r\n"),
      attempt: 1,
    });
    expect(mocks.payoutReportCsv).toHaveBeenCalledExactlyOnceWith(JAR, "2031-02");
  });

  it("del estado anterior solo lee el número de intento", async () => {
    mocks.payoutReportCsv.mockResolvedValueOnce({ kind: "unavailable" });
    expect(await payoutCsvAction({ kind: "failed", reason: "not_found", attempt: 4 }, pressed(csvButton("2031-02")))).toEqual({ kind: "failed", reason: "unavailable", attempt: 5 });
  });

  it("un periodo que no tiene reporte se dice", async () => {
    mocks.payoutReportCsv.mockResolvedValueOnce({ kind: "not_found" });
    expect(await payoutCsvAction(IDLE, pressed(csvButton("2031-02")))).toEqual({ kind: "failed", reason: "not_found", attempt: 1 });
  });

  it("quien ya no es maestro vuelve a la pantalla, donde la guarda decide", async () => {
    mocks.payoutReportCsv.mockResolvedValueOnce({ kind: "not_teacher" });
    await expect(payoutCsvAction(IDLE, pressed(csvButton("2031-02")))).rejects.toThrow(`sale a ${PAGE}`);
  });

  it("sin sesión, a entrar con la liquidación como destino; con la sesión que ya no vale, se cierra", async () => {
    mocks.payoutReportCsv.mockResolvedValueOnce({ kind: "session", check: { kind: "anonymous" } });
    await expect(payoutCsvAction(IDLE, pressed(csvButton("2031-02")))).rejects.toThrow(`sale a ${signInPath(PAGE)}`);
    mocks.payoutReportCsv.mockResolvedValueOnce({ kind: "session", check: { kind: "must_sign_out", then: "sign_in" } });
    await expect(payoutCsvAction(IDLE, pressed(csvButton("2031-02")))).rejects.toThrow(`sale a ${ROUTES.signIn}`);
    expect(mocks.leaveFor).toHaveBeenLastCalledWith(JAR, { kind: "leave", to: ROUTES.signIn, notice: null, closeSession: true });
  });

  it("«no se supo» de la guarda no saca a nadie", async () => {
    mocks.payoutReportCsv.mockResolvedValueOnce({ kind: "session", check: { kind: "unavailable" } });
    expect(await payoutCsvAction(IDLE, pressed(csvButton("2031-02")))).toEqual({ kind: "failed", reason: "unavailable", attempt: 1 });
    expect(mocks.leaveFor).not.toHaveBeenCalled();
  });
});
