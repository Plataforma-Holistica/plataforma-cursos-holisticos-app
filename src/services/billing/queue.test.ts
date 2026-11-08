import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, CodeGiven, TeamCheck, TeamStanding } from "@/services/account/team";

import type { ManualRun } from "./inbox";
import { createBillingQueue, RESOLVE_NOTE_MAX, type BillingQueueData, type BillingQueueStore } from "./queue";

// La cola de los avisos para finanzas (PA-84; T-303, tercera solicitud), con todo lo de fuera simulado: a quién se le pregunta qué, en qué orden, y qué se decide con
// cada respuesta. Contra la base de verdad, en `tests/integration/114-cola-de-avisos.test.ts` y `supabase/tests/86_cola_de_avisos.test.sql`.

const ME = "a0000000-0000-4000-8000-000000000001";
const EVENT = "e0000000-0000-4000-8000-000000000002";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const QUEUE: BillingQueueData = { freshCode: true, total: 0, events: [] };

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["finance"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function serviceWith(
  setup: {
    check?: TeamCheck | TeamCheck[];
    list?: BillingQueueData | null | "throws";
    count?: number | null | "throws";
    retry?: string | "throws";
    resolve?: string | "throws";
    run?: ManualRun;
    code?: CodeGiven;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const checks = Array.isArray(setup.check) ? [...setup.check] : null;
  const answerOf = (value: string | "throws" | undefined, fallback: string) =>
    value === "throws" ? Promise.reject(new Error("sin base")) : Promise.resolve((value ?? fallback) as never);
  const store: BillingQueueStore = {
    list: vi.fn(() => {
      calls.push("lista");
      if (setup.list === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.list === undefined ? QUEUE : setup.list);
    }),
    count: vi.fn(() => {
      calls.push("cuenta");
      if (setup.count === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.count === undefined ? 3 : setup.count);
    }),
    retry: vi.fn((_claims, event: string, revision: number) => {
      calls.push(`reintentar ${event} ${revision}`);
      return answerOf(setup.retry, "retried");
    }),
    resolve: vi.fn((_claims, event: string, note: string, revision: number) => {
      calls.push(`resolver ${event} ${note} ${revision}`);
      return answerOf(setup.resolve, "resolved");
    }),
  };
  const teamStanding = vi.fn(() => {
    calls.push("guarda");
    const next = checks === null ? (setup.check ?? teamCheck()) : (checks.shift() ?? teamCheck());
    return Promise.resolve(next as TeamCheck);
  });
  const giveSecondFactorCode = vi.fn(() => {
    calls.push("código");
    return Promise.resolve(setup.code ?? ({ kind: "verified" } as CodeGiven));
  });
  const processNow = vi.fn((event: string) => {
    calls.push(`procesar ${event}`);
    return Promise.resolve({ result: setup.run ?? ({ kind: "processed" } as ManualRun) });
  });
  const service = createBillingQueue(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    { teamStanding, giveSecondFactorCode, store, processNow },
  );
  return { service, store, calls, reported, processNow };
}

const reader = { get: () => undefined };
const jar = { get: () => undefined, set: () => undefined };

describe("leer la cola", () => {
  it("con la sección ya guardada, lee la cola con sus claims", async () => {
    const { service, calls } = serviceWith();
    expect(await service.billingQueue(reader, claims)).toEqual({ kind: "queue", queue: QUEUE });
    expect(calls).toEqual(["lista"]);
  });

  it("una lectura nula se le vuelve a preguntar a la guarda; si insiste en que tiene finanzas, se reporta", async () => {
    const insist = serviceWith({ list: null });
    expect(await insist.service.billingQueue(reader, claims)).toEqual({ kind: "unavailable" });
    expect(insist.reported).toEqual(["billing_queue_unavailable"]);
    const lost = serviceWith({ list: null, check: teamCheck(standingOf(["content"])) });
    expect(await lost.service.billingQueue(reader, claims)).toEqual({ kind: "unavailable" });
    expect(lost.reported).toEqual([]);
  });

  it("si la base no contesta, no se supo, y se reporta", async () => {
    const { service, reported } = serviceWith({ list: "throws" });
    expect(await service.billingQueue(reader, claims)).toEqual({ kind: "unavailable" });
    expect(reported).toEqual(["billing_queue_unavailable"]);
  });
});

describe("la cuenta del inicio", () => {
  it("solo para quien tiene finanzas: los demás no la leen", async () => {
    const finance = serviceWith();
    expect(await finance.service.billingQueueCount(claims, ["finance"])).toEqual({ kind: "count", count: 3 });
    const other = serviceWith();
    expect(await other.service.billingQueueCount(claims, ["content"])).toEqual({ kind: "none" });
    expect(other.calls).toEqual([]);
  });

  it("si no se pudo leer, lo dice y se reporta; nula también", async () => {
    const down = serviceWith({ count: "throws" });
    expect(await down.service.billingQueueCount(claims, ["finance"])).toEqual({ kind: "unavailable" });
    expect(down.reported).toEqual(["billing_queue_unavailable"]);
    const empty = serviceWith({ count: null });
    expect(await empty.service.billingQueueCount(claims, ["finance"])).toEqual({ kind: "unavailable" });
  });
});

describe("reintentar", () => {
  it("la guarda primero; con el aviso reabierto, se procesa en el momento", async () => {
    const { service, calls } = serviceWith();
    expect(await service.retryBillingEvent(reader, { event: EVENT, revision: "7" })).toEqual({ kind: "ran", run: { kind: "processed" } });
    expect(calls).toEqual(["guarda", `reintentar ${EVENT} 7`, `procesar ${EVENT}`]);
  });

  it("lo que pasa del tope se devuelve aparte, para terminar detrás de la respuesta", async () => {
    const { service, processNow } = serviceWith();
    const rest = Promise.resolve();
    processNow.mockResolvedValueOnce({ result: { kind: "still_pending" }, rest } as never);
    const result = await service.retryBillingEvent(reader, { event: EVENT, revision: "7" });
    expect(result).toEqual({ kind: "ran", run: { kind: "still_pending" }, rest });
  });

  it("si la base no lo reabrió, dice por qué y no procesa nada", async () => {
    for (const answer of ["changed", "self", "not_failed", "not_found", "needs_fresh_code", "forbidden"]) {
      const { service, calls } = serviceWith({ retry: answer });
      expect(await service.retryBillingEvent(reader, { event: EVENT, revision: "7" })).toEqual({ kind: "answered", answer });
      expect(calls).not.toContain(`procesar ${EVENT}`);
    }
  });

  it("una respuesta que no conoce, o ninguna, no se supo, y se reporta", async () => {
    for (const retry of ["algo", "throws"]) {
      const { service, reported } = serviceWith({ retry });
      expect(await service.retryBillingEvent(reader, { event: EVENT, revision: "7" })).toEqual({ kind: "unknown" });
      expect(reported).toEqual(["billing_queue_unavailable"]);
    }
  });

  it("sin finanzas no le pregunta nada a la base; si no se supo quién pide, tampoco", async () => {
    const refused = serviceWith({ check: teamCheck(standingOf(["content"])) });
    expect(await refused.service.retryBillingEvent(reader, { event: EVENT, revision: "7" })).toEqual({ kind: "refused" });
    expect(refused.calls).toEqual(["guarda"]);
    const unknown = serviceWith({ check: { kind: "unavailable" } as TeamCheck });
    expect(await unknown.service.retryBillingEvent(reader, { event: EVENT, revision: "7" })).toEqual({ kind: "unavailable" });
  });

  it("lo que llega sin forma no llega a la base", async () => {
    for (const input of [
      { event: "no-es-un-id", revision: "7" },
      { event: EVENT.toUpperCase(), revision: "7" },
      { event: EVENT, revision: "-1" },
      { event: EVENT, revision: "7.5" },
      { event: EVENT, revision: "" },
      { event: EVENT, revision: "99999999999" },
    ]) {
      const { service, calls } = serviceWith();
      expect(await service.retryBillingEvent(reader, input)).toEqual({ kind: "malformed" });
      expect(calls).toEqual(["guarda"]);
    }
  });
});

describe("resolver a mano", () => {
  it("con su nota, sin los espacios de las puntas", async () => {
    const { service, calls } = serviceWith();
    expect(await service.resolveBillingEvent(reader, { event: EVENT, revision: "3", note: "  Factura de prueba  " })).toEqual({
      kind: "answered",
      answer: "resolved",
    });
    expect(calls).toEqual(["guarda", `resolver ${EVENT} Factura de prueba 3`]);
  });

  it("una nota vacía o de más no llega a la base", async () => {
    for (const note of ["", "   ", "x".repeat(RESOLVE_NOTE_MAX + 1), null]) {
      const { service, calls } = serviceWith();
      expect(await service.resolveBillingEvent(reader, { event: EVENT, revision: "3", note })).toEqual({ kind: "malformed" });
      expect(calls).toEqual(["guarda"]);
    }
    const { service } = serviceWith();
    expect(await service.resolveBillingEvent(reader, { event: EVENT, revision: "3", note: "x".repeat(RESOLVE_NOTE_MAX) })).toEqual({
      kind: "answered",
      answer: "resolved",
    });
  });

  it("lo que contesta la base, de su lista; otra cosa no se supo", async () => {
    for (const answer of ["changed", "self", "not_failed", "not_found", "malformed", "needs_fresh_code", "forbidden"]) {
      const { service } = serviceWith({ resolve: answer });
      expect(await service.resolveBillingEvent(reader, { event: EVENT, revision: "3", note: "Nota" })).toEqual({ kind: "answered", answer });
    }
    const { service, reported } = serviceWith({ resolve: "throws" });
    expect(await service.resolveBillingEvent(reader, { event: EVENT, revision: "3", note: "Nota" })).toEqual({ kind: "unknown" });
    expect(reported).toEqual(["billing_queue_unavailable"]);
  });
});

describe("el código otra vez", () => {
  it("verificado, y la cola dice que ya pasa la puerta", async () => {
    const { service, calls } = serviceWith();
    expect(await service.giveBillingCode(jar, "123456")).toEqual({ kind: "verified" });
    expect(calls).toEqual(["guarda", "código", "guarda", "lista"]);
  });

  it("con el código bueno y la cola sin código reciente, no está disponible, y se reporta", async () => {
    const { service, reported } = serviceWith({ list: { ...QUEUE, freshCode: false } });
    expect(await service.giveBillingCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(reported).toEqual(["billing_queue_unavailable"]);
  });

  it("un código malo, o el freno, se dicen; dejar de ser del equipo lo decide la página", async () => {
    expect(await serviceWith({ code: { kind: "wrong_code" } }).service.giveBillingCode(jar, "1")).toEqual({ kind: "wrong_code" });
    expect(await serviceWith({ code: { kind: "throttled" } }).service.giveBillingCode(jar, "1")).toEqual({ kind: "throttled" });
    expect(await serviceWith({ code: { kind: "not_member" } }).service.giveBillingCode(jar, "1")).toEqual({ kind: "refused" });
  });
});
