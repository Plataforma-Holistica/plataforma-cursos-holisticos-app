import { beforeEach, describe, expect, it, vi } from "vitest";

// La ruta del barrido de los avisos de Stripe (T-303), con el servicio simulado. Qué reclama y qué aplica lo prueban src/services/billing/inbox.test.ts y la
// integración 113.

const mocks = vi.hoisted(() => ({ bearerToken: vi.fn(), billingSweepAllowed: vi.fn(), sweepBillingEvents: vi.fn(), sendQueuedMail: vi.fn() }));
vi.mock("@/app/_lib/request-context", () => ({ bearerToken: mocks.bearerToken }));
vi.mock("@/app/_lib/mail-requests", () => ({ sendQueuedMail: mocks.sendQueuedMail }));
vi.mock("@/services/billing/billing", () => ({ billingSweepAllowed: mocks.billingSweepAllowed, sweepBillingEvents: mocks.sweepBillingEvents }));

import { GET } from "@/app/api/trabajos/avisos/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bearerToken.mockResolvedValue("llave");
  mocks.sweepBillingEvents.mockResolvedValue(true);
  mocks.sendQueuedMail.mockResolvedValue(undefined);
});

describe("el barrido de los avisos", () => {
  it("sin la llave contesta como si no existiera, y no barre ni manda nada", async () => {
    mocks.billingSweepAllowed.mockReturnValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.sweepBillingEvents).not.toHaveBeenCalled();
    expect(mocks.sendQueuedMail).not.toHaveBeenCalled();
  });

  it("con la llave, barre y manda los recibos que se encolaron", async () => {
    mocks.billingSweepAllowed.mockReturnValue(true);
    const response = await GET();
    expect(mocks.billingSweepAllowed).toHaveBeenCalledWith("llave");
    expect(mocks.sweepBillingEvents).toHaveBeenCalledTimes(1);
    expect(mocks.sendQueuedMail).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("si la base falló a media pasada, Vercel lo ve, y lo que ya se encoló sale igual", async () => {
    mocks.billingSweepAllowed.mockReturnValue(true);
    mocks.sweepBillingEvents.mockResolvedValue(false);
    expect((await GET()).status).toBe(503);
    expect(mocks.sendQueuedMail).toHaveBeenCalledTimes(1);
  });
});
