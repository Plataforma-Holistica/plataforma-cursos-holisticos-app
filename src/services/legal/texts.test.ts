import { beforeEach, describe, expect, it, vi } from "vitest";

// El servicio que lee un texto legal, sin base: qué pregunta, cuánto recuerda y qué hace
// cuando la base no contesta. Contra la base de verdad está en
// tests/integration/64-textos-legales.test.ts.

const db = vi.hoisted(() => ({ asSystem: vi.fn() }));
vi.mock("@/adapters/supabase/db", () => db);
vi.mock("@/config/env", () => ({ getEnv: () => ({ APP_ENV: "local" }) }));
vi.mock("@sentry/nextjs", () => ({ init: vi.fn(), captureRequestError: vi.fn() }));

import { createLegalTexts, LEGAL_TEXT_MEMORY_MS } from "./texts";

const stored = { id: "11111111-1111-4111-8111-111111111111", version: 2, title: "Términos", body: "Texto.", effective_from: "2026-11-12T06:00:00.000Z" };

function legal(options: { isLocal?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const reported: string[] = [];
  const texts = createLegalTexts({
    isLocal: () => options.isLocal ?? false,
    now: () => clock.now,
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
  return { ...texts, clock, reported };
}

const answers = (rows: unknown[]) => db.asSystem.mockResolvedValue(rows);

beforeEach(() => vi.clearAllMocks());

describe("el texto vigente de un tipo público", () => {
  it("lo lee de la base y lo devuelve completo", async () => {
    answers([stored]);
    expect(await legal().currentLegalText("terms")).toEqual({
      kind: "found",
      text: {
        docType: "terms",
        documentId: stored.id,
        version: 2,
        title: "Términos",
        body: "Texto.",
        effectiveFrom: "2026-11-12T06:00:00.000Z",
      },
    });
    expect(db.asSystem).toHaveBeenCalledOnce();
  });

  it.each(["license_annex", "teacher_agreement", "teacher_privacy_notice", "no_existe", "", "TERMS", "terms; drop table x"])(
    "un tipo que no es público no se encuentra, y ni llega a la base: %j",
    async (docType) => {
      answers([stored]);
      const service = legal();
      expect(await service.currentLegalText(docType)).toEqual({ kind: "not_found" });
      expect(db.asSystem).not.toHaveBeenCalled();
      expect(service.reported).toEqual([]);
    },
  );

  it("un tipo público sin texto vigente no se encuentra", async () => {
    answers([]);
    expect(await legal().currentLegalText("refund_policy")).toEqual({ kind: "not_found" });
  });

  it("un borrador solo se muestra en local", async () => {
    answers([{ ...stored, version: 0 }]);
    expect(await legal({ isLocal: false }).currentLegalText("terms")).toEqual({ kind: "not_found" });
    expect(await legal({ isLocal: true }).currentLegalText("terms")).toMatchObject({ kind: "found", text: { version: 0 } });
    // Una versión publicada se muestra en todos lados.
    answers([{ ...stored, version: 1 }]);
    expect(await legal({ isLocal: false }).currentLegalText("terms")).toMatchObject({ kind: "found" });
  });
});

describe("lo leído se recuerda unos segundos", () => {
  it("pedir el mismo texto otra vez no vuelve a la base hasta que pasa ese tiempo", async () => {
    answers([stored]);
    const service = legal();
    await service.currentLegalText("terms");
    service.clock.now += LEGAL_TEXT_MEMORY_MS - 1;
    expect(await service.currentLegalText("terms")).toMatchObject({ kind: "found" });
    expect(db.asSystem).toHaveBeenCalledTimes(1);

    service.clock.now += 1;
    answers([{ ...stored, version: 3 }]);
    expect(await service.currentLegalText("terms")).toMatchObject({ text: { version: 3 } });
    expect(db.asSystem).toHaveBeenCalledTimes(2);
  });

  it("cada tipo se recuerda aparte, y que no tenga texto también se recuerda", async () => {
    answers([]);
    const service = legal();
    await service.currentLegalText("refund_policy");
    await service.currentLegalText("refund_policy");
    expect(db.asSystem).toHaveBeenCalledTimes(1);
    answers([stored]);
    expect(await service.currentLegalText("terms")).toMatchObject({ kind: "found" });
    expect(db.asSystem).toHaveBeenCalledTimes(2);
    expect(LEGAL_TEXT_MEMORY_MS).toBe(30_000);
  });
});

describe("cuando la base no contesta", () => {
  it("no se supo: se reporta, no es «no encontrado» y no se recuerda", async () => {
    db.asSystem.mockRejectedValueOnce(new Error("sin base"));
    const service = legal();
    expect(await service.currentLegalText("terms")).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["legal_text_unavailable"]);

    answers([stored]);
    expect(await service.currentLegalText("terms")).toMatchObject({ kind: "found" });
    expect(service.reported).toHaveLength(1);
  });

  it("lo que ya se recordaba no sirve para tapar un fallo cuando caduca", async () => {
    answers([stored]);
    const service = legal();
    await service.currentLegalText("terms");
    service.clock.now += LEGAL_TEXT_MEMORY_MS;
    db.asSystem.mockRejectedValueOnce(new Error("sin base"));
    expect(await service.currentLegalText("terms")).toEqual({ kind: "unavailable" });
  });
});
