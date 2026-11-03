import { beforeEach, describe, expect, it, vi } from "vitest";

// La ruta del barrido de correo (T-604), con el servicio simulado. Qué manda y qué reporta lo prueban src/services/mail/outbox.test.ts y la integración 86.

const mocks = vi.hoisted(() => ({ bearerToken: vi.fn(), mailSweepAllowed: vi.fn(), sweepMail: vi.fn() }));
vi.mock("@/app/_lib/request-context", () => ({ bearerToken: mocks.bearerToken }));
vi.mock("@/app/_lib/mail-copy", () => ({ mailCopy: { marca: "textos" } }));
vi.mock("@/services/mail/mail", () => ({ mailSweepAllowed: mocks.mailSweepAllowed, sweepMail: mocks.sweepMail }));

import { GET } from "@/app/api/trabajos/correo/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bearerToken.mockResolvedValue("llave");
  mocks.sweepMail.mockResolvedValue(true);
});

describe("el barrido de correo", () => {
  it("sin la llave contesta como si no existiera, y no manda nada", async () => {
    mocks.mailSweepAllowed.mockReturnValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.sweepMail).not.toHaveBeenCalled();
  });

  it("con la llave, barre", async () => {
    mocks.mailSweepAllowed.mockReturnValue(true);
    const response = await GET();
    expect(mocks.mailSweepAllowed).toHaveBeenCalledWith("llave");
    expect(mocks.sweepMail).toHaveBeenCalledWith({ marca: "textos" });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("si no pudo preguntar, Vercel lo ve", async () => {
    mocks.mailSweepAllowed.mockReturnValue(true);
    mocks.sweepMail.mockResolvedValue(false);
    expect((await GET()).status).toBe(503);
  });
});
