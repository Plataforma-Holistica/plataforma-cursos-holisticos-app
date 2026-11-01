import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";

import { createPayoutsPanel, PayoutFailure, type FinancePayouts, type PayoutStore, type Released } from "./payouts";

// Las liquidaciones del periodo (PA-81), con todo lo de fuera simulado: a quién se le pregunta qué, en qué
// orden, qué no llega a la base y qué se decide con cada respuesta. Contra la base de verdad, en
// `tests/integration/58-liquidaciones.test.ts` y `supabase/tests/55_liquidaciones_del_periodo.test.sql`.

const ME = "a0000000-0000-4000-8000-000000000001";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const PAYOUT = "d1000000-0000-4000-8000-000000000001";
const TEACHER = "b0000000-0000-4000-8000-000000000002";
const BONUS = "e1000000-0000-4000-8000-000000000001";
const SEEN = "ab".repeat(32);
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const PAYOUTS = { freshCode: true, period: { periodId: 202710 } } as unknown as FinancePayouts;

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["finance"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function serviceWith(
  setup: {
    check?: TeamCheck | TeamCheck[];
    payouts?: FinancePayouts | null | "throws";
    fail?: "throws" | PayoutFailure;
    released?: Released;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const checks = Array.isArray(setup.check) ? [...setup.check] : null;
  const answer = <T>(value: T) => {
    if (setup.fail === "throws") return Promise.reject(new Error("sin base"));
    if (setup.fail instanceof PayoutFailure) return Promise.reject(setup.fail);
    return Promise.resolve(value);
  };
  const store: PayoutStore = {
    payouts: vi.fn((_claims, period: number) => {
      calls.push(`liquidaciones ${period}`);
      if (setup.payouts === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.payouts === undefined ? PAYOUTS : setup.payouts);
    }),
    release: vi.fn((_claims, period: number, seen: string) => {
      calls.push(`liberar ${period} ${seen.slice(0, 4)}`);
      return answer(setup.released ?? { answer: "released" as const, blockingPeriod: null, periodStatus: "closed" as const, teachers: [] });
    }),
    hold: vi.fn((_claims, payout: string, reason: string, seen: string) => {
      calls.push(`retener ${payout.slice(0, 4)} «${reason}» ${seen}`);
      return answer({ answer: "held" as const, status: null });
    }),
    unhold: vi.fn((_claims, payout: string, note: string | null, seen: string) => {
      calls.push(`soltar ${payout.slice(0, 4)} ${note === null ? "sin nota" : `«${note}»`} ${seen.slice(0, 4)}`);
      return answer({ answer: "released_from_hold" as const, to: "awaiting_invoice" as const });
    }),
    confirmFounder: vi.fn((_claims, bonus: string) => {
      calls.push(`confirmar ${bonus.slice(0, 4)}`);
      return answer({ answer: "confirmed" as const, status: null });
    }),
    voidFounder: vi.fn((_claims, period: number, bonus: string, reason: string) => {
      calls.push(`anular ${period} ${bonus.slice(0, 4)} «${reason}»`);
      return answer("voided" as const);
    }),
  };
  const service = createPayoutsPanel(
    {
      report: async (code) => {
        reported.push(code);
      },
    },
    {
      teamStanding: vi.fn(async () => {
        calls.push("guarda");
        if (checks) return checks.shift() ?? teamCheck();
        return (setup.check as TeamCheck | undefined) ?? teamCheck();
      }),
      store,
    },
  );
  return { service, calls, reported };
}

const reader = {} as never;

describe("leer las liquidaciones", () => {
  it("lee con las claims que la guarda de la sección dio, sin volver a correrla", async () => {
    const { service, calls } = serviceWith();
    expect(await service.financePayouts(reader, claims, 202710)).toEqual({ kind: "payouts", payouts: PAYOUTS });
    expect(calls).toEqual(["liquidaciones 202710"]);
  });

  it("un periodo sin forma no existe, y no se le pregunta a la base", async () => {
    const { service, calls } = serviceWith();
    expect(await service.financePayouts(reader, claims, 202713)).toEqual({ kind: "not_found" });
    expect(calls).toEqual([]);
  });

  it("uno que la base no tiene, tampoco", async () => {
    const { service } = serviceWith({ payouts: { freshCode: true, period: null } });
    expect(await service.financePayouts(reader, claims, 202710)).toEqual({ kind: "not_found" });
  });

  it("una lectura nula vuelve a preguntarle a la guarda, y solo si insiste en que pasa con finanzas se reporta", async () => {
    const { service, calls, reported } = serviceWith({ payouts: null });
    expect(await service.financePayouts(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(calls).toEqual(["liquidaciones 202710", "guarda"]);
    expect(reported).toEqual(["payouts_unavailable"]);
  });

  it("si la guarda ya no lo deja pasar, no se reporta", async () => {
    const { service, reported } = serviceWith({ payouts: null, check: teamCheck(standingOf(["content"])) });
    expect(await service.financePayouts(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(reported).toEqual([]);
  });

  it("si la base no contesta, se reporta", async () => {
    const { service, reported } = serviceWith({ payouts: "throws" });
    expect(await service.financePayouts(reader, claims, 202710)).toEqual({ kind: "unavailable" });
    expect(reported).toEqual(["payouts_unavailable"]);
  });
});

describe("la guarda va primero", () => {
  const decisions = (service: ReturnType<typeof serviceWith>["service"]) => [
    service.releasePayouts(reader, { period: 202710, seen: SEEN }),
    service.holdPayout(reader, { payout: PAYOUT, reason: "Se revisa.", seen: "calculated" }),
    service.unholdPayout(reader, { payout: PAYOUT, note: "", seen: SEEN }),
    service.confirmFounderBonus(reader, { bonus: BONUS }),
    service.voidFounderBonus(reader, { period: 202710, bonus: BONUS, reason: "No aplica." }),
  ];

  it("a quien no tiene finanzas se le contesta refused sin preguntarle nada a la base", async () => {
    const { service, calls } = serviceWith({ check: teamCheck(standingOf(["content"])) });
    for (const result of await Promise.all(decisions(service))) expect(result).toEqual({ kind: "refused" });
    expect(calls.every((call) => call === "guarda")).toBe(true);
  });

  it("si no se supo quién pide, unavailable", async () => {
    const { service, calls } = serviceWith({ check: { kind: "unavailable" } as TeamCheck });
    for (const result of await Promise.all(decisions(service))) expect(result).toEqual({ kind: "unavailable" });
    expect(calls.every((call) => call === "guarda")).toBe(true);
  });
});

describe("liberar", () => {
  it("con la huella de lo que se vio", async () => {
    const { service, calls } = serviceWith();
    expect(await service.releasePayouts(reader, { period: 202710, seen: SEEN })).toEqual({
      kind: "answered",
      answer: "released",
      blockingPeriod: null,
      periodStatus: "closed",
      teachers: [],
    });
    expect(calls).toEqual(["guarda", "liberar 202710 abab"]);
  });

  it.each([
    ["sin huella", { period: 202710, seen: undefined }],
    ["una huella sin forma", { period: 202710, seen: "AB".repeat(32) }],
    ["una huella corta", { period: 202710, seen: "ab" }],
    ["un periodo sin forma", { period: "202710", seen: SEEN }],
  ])("%s no llega a la base", async (_name, input) => {
    const { service, calls } = serviceWith();
    expect(await service.releasePayouts(reader, input)).toEqual({ kind: "malformed" });
    expect(calls).toEqual(["guarda"]);
  });

  it.each(["withholding_rules_missing", "tax_data_missing"] as const)("%s llega tal cual, con a quién detiene", async (answer) => {
    const { service } = serviceWith({ released: { answer, blockingPeriod: null, periodStatus: null, teachers: [TEACHER] } });
    expect(await service.releasePayouts(reader, { period: 202710, seen: SEEN })).toEqual({ kind: "answered", answer, blockingPeriod: null, periodStatus: null, teachers: [TEACHER] });
  });

  it("el tope de tiempo y lo que no cuadra al confirmar se dicen por su nombre, con su propio reporte", async () => {
    const timed = serviceWith({ fail: new PayoutFailure("timed_out") });
    expect(await timed.service.releasePayouts(reader, { period: 202710, seen: SEEN })).toEqual({ kind: "timed_out" });
    expect(timed.reported).toEqual(["release_timed_out"]);
    const unbalanced = serviceWith({ fail: new PayoutFailure("unbalanced") });
    expect(await unbalanced.service.releasePayouts(reader, { period: 202710, seen: SEEN })).toEqual({ kind: "unbalanced" });
    expect(unbalanced.reported).toEqual(["release_unbalanced"]);
  });

  it("si la base no contestó, no se supo, y se reporta", async () => {
    const { service, reported } = serviceWith({ fail: "throws" });
    expect(await service.releasePayouts(reader, { period: 202710, seen: SEEN })).toEqual({ kind: "unknown" });
    expect(reported).toEqual(["payout_change_unavailable"]);
  });
});

describe("retener y soltar", () => {
  it("retener lleva el motivo recortado y el estado que se vio", async () => {
    const { service, calls } = serviceWith();
    expect(await service.holdPayout(reader, { payout: PAYOUT, reason: "  Se revisa.  ", seen: "awaiting_invoice" })).toEqual({
      kind: "answered",
      answer: "held",
      status: null,
    });
    expect(calls).toEqual(["guarda", "retener d100 «Se revisa.» awaiting_invoice"]);
  });

  it.each([
    ["sin motivo", { payout: PAYOUT, reason: "   ", seen: "calculated" }],
    ["un motivo desmedido", { payout: PAYOUT, reason: "x".repeat(2001), seen: "calculated" }],
    ["un estado que no existe", { payout: PAYOUT, reason: "Se revisa.", seen: "frozen" }],
    ["sin estado", { payout: PAYOUT, reason: "Se revisa.", seen: undefined }],
    ["una liquidación sin forma", { payout: PAYOUT.toUpperCase(), reason: "Se revisa.", seen: "calculated" }],
  ])("retener %s no llega a la base", async (_name, input) => {
    const { service, calls } = serviceWith();
    expect(await service.holdPayout(reader, input)).toEqual({ kind: "malformed" });
    expect(calls).toEqual(["guarda"]);
  });

  it("si retener no contestó, no se supo", async () => {
    const { service, reported } = serviceWith({ fail: "throws" });
    expect(await service.holdPayout(reader, { payout: PAYOUT, reason: "Se revisa.", seen: "calculated" })).toEqual({ kind: "unknown" });
    expect(reported).toEqual(["payout_change_unavailable"]);
  });

  it("soltar lleva la huella, y la nota solo si trae algo", async () => {
    const { service, calls } = serviceWith();
    await service.unholdPayout(reader, { payout: PAYOUT, note: "  ", seen: SEEN });
    await service.unholdPayout(reader, { payout: PAYOUT, note: " Todo en orden. ", seen: SEEN });
    await service.unholdPayout(reader, { payout: PAYOUT, note: undefined, seen: SEEN });
    expect(calls.filter((call) => call !== "guarda")).toEqual([
      "soltar d100 sin nota abab",
      "soltar d100 «Todo en orden.» abab",
      "soltar d100 sin nota abab",
    ]);
  });

  it.each([
    ["sin huella", { payout: PAYOUT, note: "", seen: undefined }],
    ["una nota desmedida", { payout: PAYOUT, note: "x".repeat(2001), seen: SEEN }],
    ["una liquidación sin forma", { payout: "nada", note: "", seen: SEEN }],
  ])("soltar %s no llega a la base", async (_name, input) => {
    const { service, calls } = serviceWith();
    expect(await service.unholdPayout(reader, input)).toEqual({ kind: "malformed" });
    expect(calls).toEqual(["guarda"]);
  });

  it("soltar puede liberar ahí mismo: el tope de tiempo y lo que no cuadra se dicen por su nombre", async () => {
    const { service, reported } = serviceWith({ fail: new PayoutFailure("unbalanced") });
    expect(await service.unholdPayout(reader, { payout: PAYOUT, note: "", seen: SEEN })).toEqual({ kind: "unbalanced" });
    expect(reported).toEqual(["release_unbalanced"]);
  });
});

describe("el bono del fundador", () => {
  it("confirmar", async () => {
    const { service, calls } = serviceWith();
    expect(await service.confirmFounderBonus(reader, { bonus: BONUS })).toEqual({ kind: "answered", answer: "confirmed", status: null });
    expect(calls).toEqual(["guarda", "confirmar e100"]);
  });

  it("anular lleva el periodo, para que solo se anule el del fundador de ese periodo", async () => {
    const { service, calls } = serviceWith();
    expect(await service.voidFounderBonus(reader, { period: 202710, bonus: BONUS, reason: "No aplica." })).toEqual({
      kind: "answered",
      answer: "voided",
    });
    expect(calls).toEqual(["guarda", "anular 202710 e100 «No aplica.»"]);
  });

  it.each([
    ["sin motivo", { period: 202710, bonus: BONUS, reason: "" }],
    ["sin periodo", { period: null, bonus: BONUS, reason: "No aplica." }],
    ["un bono sin forma", { period: 202710, bonus: 7, reason: "No aplica." }],
  ])("anular %s no llega a la base", async (_name, input) => {
    const { service, calls } = serviceWith();
    expect(await service.voidFounderBonus(reader, input)).toEqual({ kind: "malformed" });
    expect(calls).toEqual(["guarda"]);
  });

  it("confirmar un bono sin forma no llega a la base", async () => {
    const { service, calls } = serviceWith();
    expect(await service.confirmFounderBonus(reader, { bonus: "x" })).toEqual({ kind: "malformed" });
    expect(calls).toEqual(["guarda"]);
  });

  it("si la base no contestó, no se supo", async () => {
    const { service, reported } = serviceWith({ fail: "throws" });
    expect(await service.confirmFounderBonus(reader, { bonus: BONUS })).toEqual({ kind: "unknown" });
    expect(await service.voidFounderBonus(reader, { period: 202710, bonus: BONUS, reason: "No aplica." })).toEqual({ kind: "unknown" });
    expect(reported).toEqual(["payout_change_unavailable", "payout_change_unavailable"]);
  });
});
