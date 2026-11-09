import { describe, expect, it, vi } from "vitest";

import type { StripeAnswer, StripeGet } from "@/adapters/stripe/api";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";

import {
  createReconciliation,
  EXPLAIN_NOTE_MAX,
  LIST_BUDGET_MS,
  listCharges,
  MONTH_MIN_MS,
  SWEEP_BUDGET_MS,
  type Actor,
  type ReconcileStore,
  type RecordAnswer,
  type StripeCharge,
  type WindowAnswer,
} from "./reconcile";

// La conciliación con Stripe (T-303, cuarta solicitud), con todo lo de fuera simulado: qué se le pide a Stripe, en qué partes y qué se manda a la base. Lo que la
// base hace con eso lo prueban `supabase/tests/87_conciliacion.test.sql` y `tests/integration/115-conciliacion.test.ts`.

const ME = "a0000000-0000-4000-8000-000000000001";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (capabilities: Capability[] = ["finance"]): TeamCheck => ({ kind: "team", claims, standing: standingOf(capabilities), inProgress: null });
const reader = { get: () => undefined } as never;

const DAY = 86_400;
const START = 1_790_000_000;

const charge = (id: string, created: number, extra: Partial<StripeCharge> = {}): StripeCharge & { object: string; amount: number } => ({
  id,
  object: "charge",
  amount: 34_900,
  status: "succeeded",
  captured: true,
  refunded: false,
  currency: "mxn",
  livemode: false,
  created,
  amount_captured: 34_900,
  ...extra,
});

/** Un Stripe simulado: cada página de cada día, en orden, y lo que se pidió. */
function stripeWith(pages: Record<string, StripeAnswer[]>): { get: StripeGet; asked: string[] } {
  const asked: string[] = [];
  const get: StripeGet = (path, query = {}) => {
    const q = query as Record<string, string | readonly string[]>;
    asked.push(`${path}?${Object.entries(q).map(([k, v]) => `${k}=${String(v)}`).join("&")}`);
    const key = path === "/v1/charges" ? String(q["created[gte]"]) : path;
    const next = pages[key]?.shift();
    return Promise.resolve(next ?? { status: "ok", body: { object: "list", data: [], has_more: false } });
  };
  return { get, asked };
}
const page = (data: unknown[], has_more = false): StripeAnswer => ({ status: "ok", body: { object: "list", data, has_more } });

describe("listar los cargos de una ventana", () => {
  it("parte la ventana por días, sigue cada día página por página y no deja un cargo dos veces", async () => {
    const { get, asked } = stripeWith({
      [String(START)]: [page([charge("ch_a", START + 10), charge("ch_b", START + 20)], true), page([charge("ch_b", START + 20), charge("ch_c", START + 30)])],
      [String(START + DAY)]: [page([charge("ch_d", START + DAY + 5)])],
    });
    const listed = await listCharges(get, START, START + DAY + 3_600, Number.POSITIVE_INFINITY, () => 0);
    expect(listed.complete).toBe(true);
    expect(listed.failure).toBeNull();
    expect(listed.charges.map((c) => c.id).sort()).toEqual(["ch_a", "ch_b", "ch_c", "ch_d"]);
    // Solo viaja lo que la base necesita.
    expect(Object.keys(listed.charges[0]!).sort()).toEqual(["amount_captured", "captured", "created", "currency", "id", "livemode", "refunded", "status"]);
    expect(asked).toContain(`/v1/charges?created[gte]=${START}&created[lt]=${START + DAY}&limit=100`);
    expect(asked).toContain(`/v1/charges?created[gte]=${START}&created[lt]=${START + DAY}&limit=100&starting_after=ch_b`);
    // El último día termina en el fin de la ventana, no un día después.
    expect(asked).toContain(`/v1/charges?created[gte]=${START + DAY}&created[lt]=${START + DAY + 3_600}&limit=100`);
  });

  it("con el tope de tiempo vencido, deja de pedir y el listado queda incompleto", async () => {
    const { get, asked } = stripeWith({});
    const listed = await listCharges(get, START, START + 3 * DAY, 100, () => 100);
    expect(listed).toEqual({ complete: false, charges: [], failure: null });
    expect(asked).toEqual([]);
  });

  it("una lectura que Stripe no contesta deja el listado incompleto y dice qué reportar", async () => {
    const unavailable = await listCharges(stripeWith({ [String(START)]: [{ status: "unavailable" }] }).get, START, START + DAY, Infinity, () => 0);
    expect(unavailable).toMatchObject({ complete: false, failure: "billing_reconciliation_unavailable" });
    const key = await listCharges(stripeWith({ [String(START)]: [{ status: "unauthorized" }] }).get, START, START + DAY, Infinity, () => 0);
    expect(key).toMatchObject({ complete: false, failure: "stripe_key_rejected" });
  });

  it("una página con otra forma no se adivina: incompleto", async () => {
    const odd = await listCharges(stripeWith({ [String(START)]: [{ status: "ok", body: { data: [{ id: "ch_x" }], has_more: false } }] }).get, START, START + DAY, Infinity, () => 0);
    expect(odd).toMatchObject({ complete: false, charges: [], failure: "billing_reconciliation_unavailable" });
  });

  it("una página vacía que dice que hay más no se sigue ni se da por terminada", async () => {
    const listed = await listCharges(stripeWith({ [String(START)]: [page([], true)] }).get, START, START + DAY, Infinity, () => 0);
    expect(listed).toMatchObject({ complete: false, failure: "billing_reconciliation_unavailable" });
  });
});

function serviceWith(
  setup: {
    check?: TeamCheck;
    window?: WindowAnswer | "throws";
    record?: RecordAnswer | "throws";
    due?: { period: number; overdue: boolean }[] | "throws";
    settlement?: "recorded" | "mismatch";
    missing?: string[];
    stripe?: { get: StripeGet } | null;
    explain?: string | "throws";
    clock?: () => number;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const recorded: { actor: Actor; args: unknown[] }[] = [];
  const settled: unknown[] = [];
  const store: ReconcileStore = {
    window: vi.fn((actor: Actor, period: number): Promise<WindowAnswer> => {
      calls.push(`ventana ${actor.kind} ${period}`);
      if (setup.window === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.window ?? { kind: "window", startsAt: START, endsAt: START + DAY });
    }),
    record: vi.fn((actor: Actor, ...args: unknown[]): Promise<RecordAnswer> => {
      calls.push("registrar");
      recorded.push({ actor, args });
      if (setup.record === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.record ?? { kind: "recorded", id: "r", matches: true, differences: 0 });
    }),
    due: vi.fn(() => {
      calls.push("pendientes");
      if (setup.due === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.due ?? []);
    }),
    settlementsMissing: vi.fn(() => {
      calls.push("sin liquidar");
      return Promise.resolve(setup.missing ?? []);
    }),
    completeSettlement: vi.fn((_actor: Actor, settlement: unknown) => {
      settled.push(settlement);
      return Promise.resolve(setup.settlement ?? "recorded");
    }),
    explain: vi.fn((_claims: VerifiedClaims, explanation: unknown) => {
      calls.push(`explicar ${JSON.stringify(explanation)}`);
      if (setup.explain === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve((setup.explain ?? "explained") as never);
    }),
  };
  const stripe = setup.stripe === undefined ? stripeWith({}) : setup.stripe;
  const service = createReconciliation(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: () => {
        calls.push("guarda");
        return Promise.resolve(setup.check ?? teamCheck());
      },
      store,
      stripe: () => stripe?.get ?? null,
      live: () => false,
      now: setup.clock ?? (() => 0),
    },
  );
  return { service, calls, reported, recorded, settled };
}

describe("comparar un periodo", () => {
  it("«Comparar ahora» pasa la guarda, pide la ventana a nombre de la persona, lista y registra con lo leído", async () => {
    const stripe = stripeWith({ [String(START)]: [page([charge("ch_a", START + 1), charge("ch_b", START + 2, { status: "pending", captured: false })])] });
    const { service, calls, recorded } = serviceWith({ stripe });
    const result = await service.compareNow(reader, 202_610);
    expect(result).toEqual({ kind: "compared", result: { kind: "recorded", matches: true, complete: true, differences: 0 } });
    expect(calls).toEqual(["guarda", "ventana person 202610", "registrar", "sin liquidar"]);
    expect(recorded[0]!.actor).toEqual({ kind: "person", claims });
    const [period, live, starts, ends, complete, charges] = recorded[0]!.args as [number, boolean, number, number, boolean, StripeCharge[]];
    expect([period, live, starts, ends, complete]).toEqual([202_610, false, START, START + DAY, true]);
    // Lo pendiente también viaja: lo clasifica la base.
    expect(charges.map((c) => [c.id, c.status])).toEqual([
      ["ch_a", "succeeded"],
      ["ch_b", "pending"],
    ]);
  });

  it("quien no tiene finanzas no llega a la base ni a Stripe", async () => {
    const { service, calls } = serviceWith({ check: teamCheck(["content"]) });
    expect(await service.compareNow(reader, 202_610)).toEqual({ kind: "refused" });
    expect(calls).toEqual(["guarda"]);
  });

  it("sin la llave de Stripe no compara", async () => {
    const { service, calls } = serviceWith({ stripe: null });
    expect(await service.compareNow(reader, 202_610)).toEqual({ kind: "compared", result: { kind: "no_stripe" } });
    expect(calls).toEqual(["guarda"]);
  });

  it("lo que la base rechaza de la ventana se dice tal cual, sin listar", async () => {
    const { service, calls } = serviceWith({ window: { kind: "refused", answer: "too_early" } });
    expect(await service.compareNow(reader, 202_611)).toEqual({ kind: "compared", result: { kind: "refused", answer: "too_early" } });
    expect(calls).not.toContain("registrar");
  });

  it("una forma que la base rechaza se reporta: es un error de este lado o de Stripe", async () => {
    const { service, reported } = serviceWith({ record: { kind: "refused", answer: "malformed" } });
    expect(await service.compareNow(reader, 202_610)).toEqual({ kind: "compared", result: { kind: "refused", answer: "malformed" } });
    expect(reported).toEqual(["billing_reconciliation_rejected"]);
  });

  it("un listado que no terminó se registra como incompleto, y se reporta lo que falló", async () => {
    const stripe = stripeWith({ [String(START)]: [{ status: "unavailable" }] });
    const { service, recorded, reported } = serviceWith({ stripe, record: { kind: "recorded", id: "r", matches: false, differences: 0 } });
    expect(await service.compareNow(reader, 202_610)).toEqual({ kind: "compared", result: { kind: "recorded", matches: false, complete: false, differences: 0 } });
    expect(recorded[0]!.args[4]).toBe(false);
    expect(reported).toEqual(["billing_reconciliation_unavailable"]);
  });

  it("si la base no contesta, «no se supo», reportado", async () => {
    const { service, reported } = serviceWith({ record: "throws" });
    expect(await service.compareNow(reader, 202_610)).toEqual({ kind: "compared", result: { kind: "unknown" } });
    expect(reported).toEqual(["billing_reconciliation_unavailable"]);
  });

  it("el tope de la lista es el de la pasada: con el reloj pasado, no pide y queda incompleta", async () => {
    // La primera lectura del reloj fija el tope; las siguientes ya lo pasaron.
    let reads = 0;
    const stripe = stripeWith({});
    const { service, recorded } = serviceWith({ stripe, clock: () => (reads++ === 0 ? 0 : LIST_BUDGET_MS) });
    await service.compareNow(reader, 202_610);
    expect(recorded[0]!.args[4]).toBe(false);
    expect(stripe.asked).toEqual([]);
  });
});

describe("completar lo que liquidó Stripe", () => {
  it("lee cada cobro sin liquidar con su transacción de saldo y la manda con sus montos", async () => {
    const stripe = stripeWith({
      "/v1/charges/ch_a": [
        { status: "ok", body: { id: "ch_a", currency: "mxn", balance_transaction: { id: "txn_a", amount: 34_900, fee: 1_500, net: 33_400, currency: "mxn", available_on: 1_790_600_000 } } },
      ],
      // Sin transacción todavía, de otra moneda o sin contestar: se deja para otra pasada.
      "/v1/charges/ch_b": [{ status: "ok", body: { id: "ch_b", currency: "mxn", balance_transaction: null } }],
      "/v1/charges/ch_c": [
        { status: "ok", body: { id: "ch_c", currency: "mxn", balance_transaction: { id: "txn_c", amount: 1, fee: 0, net: 1, currency: "usd", available_on: 1 } } },
      ],
      "/v1/charges/ch_d": [{ status: "unavailable" }],
    });
    const { service, settled, reported } = serviceWith({ stripe, missing: ["ch_a", "ch_b", "ch_c", "ch_d"] });
    await service.compareNow(reader, 202_610);
    expect(reported).toEqual([]);
    expect(settled).toEqual([
      { charge: "ch_a", transaction: "txn_a", grossCents: 34_900, feeCents: 1_500, netCents: 33_400, availableOn: new Date(1_790_600_000_000).toISOString() },
    ]);
    expect(stripe.asked).toContain("/v1/charges/ch_a?expand[]=balance_transaction");
  });

  it("si la base dice que el bruto no es el del cobro, se reporta", async () => {
    const stripe = stripeWith({
      "/v1/charges/ch_a": [
        { status: "ok", body: { id: "ch_a", currency: "mxn", balance_transaction: { id: "txn_a", amount: 1, fee: 0, net: 1, currency: "mxn", available_on: 1 } } },
      ],
    });
    const { service, reported } = serviceWith({ stripe, missing: ["ch_a"], settlement: "mismatch" });
    await service.compareNow(reader, 202_610);
    expect(reported).toEqual(["billing_settlement_mismatch"]);
  });
});

describe("el trabajo de cada día", () => {
  it("compara como sistema cada periodo que pide la base, y reporta uno que no coincide", async () => {
    const { service, calls, reported } = serviceWith({
      due: [
        { period: 202_609, overdue: false },
        { period: 202_610, overdue: false },
      ],
      record: { kind: "recorded", id: "r", matches: false, differences: 1 },
    });
    expect(await service.sweepReconciliations()).toBe(true);
    expect(calls.filter((c) => c.startsWith("ventana"))).toEqual(["ventana system 202609", "ventana system 202610"]);
    expect(reported).toEqual(["billing_reconciliation_mismatch", "billing_reconciliation_mismatch"]);
  });

  it("un mes con dos días sin conciliar se reporta aparte; uno que ya coincide, no", async () => {
    const late = serviceWith({ due: [{ period: 202_610, overdue: true }], record: { kind: "recorded", id: "r", matches: false, differences: 1 } });
    await late.service.sweepReconciliations();
    expect(late.reported).toEqual(["billing_reconciliation_mismatch", "billing_reconciliation_overdue"]);
    const fixed = serviceWith({ due: [{ period: 202_610, overdue: true }] });
    await fixed.service.sweepReconciliations();
    expect(fixed.reported).toEqual([]);
  });

  it("una lista que no terminó se reporta como incompleta, no como diferencia", async () => {
    const stripe = stripeWith({ [String(START)]: [{ status: "unavailable" }] });
    const { service, reported } = serviceWith({ stripe, due: [{ period: 202_610, overdue: false }], record: { kind: "recorded", id: "r", matches: false, differences: 0 } });
    await service.sweepReconciliations();
    expect(reported).toEqual(["billing_reconciliation_unavailable", "billing_reconciliation_incomplete"]);
  });

  it("toda la pasada tiene un tope: un mes sin tiempo suficiente queda para mañana, sin registrar ni contar como falla, y si ya lleva dos días se dice", async () => {
    // El reloj fija el tope de la pasada al empezar; al segundo mes ya no quedan los 25 s que pide uno.
    const clock = [0, 0, 0, SWEEP_BUDGET_MS - MONTH_MIN_MS];
    const { service, calls, reported } = serviceWith({
      due: [
        { period: 202_609, overdue: false },
        { period: 202_610, overdue: true },
      ],
      clock: () => clock.shift() ?? SWEEP_BUDGET_MS,
    });
    expect(await service.sweepReconciliations()).toBe(true);
    expect(calls.filter((c) => c.startsWith("ventana"))).toEqual(["ventana system 202609"]);
    expect(calls.filter((c) => c === "registrar")).toHaveLength(1);
    expect(reported).toEqual(["billing_reconciliation_overdue"]);
  });

  it("sin la llave de Stripe no compara, y lo dice cada día que haya un mes esperando", async () => {
    const waiting = serviceWith({ stripe: null, due: [{ period: 202_610, overdue: false }] });
    expect(await waiting.service.sweepReconciliations()).toBe(false);
    expect(waiting.calls).toEqual(["pendientes"]);
    expect(waiting.reported).toEqual(["billing_reconciliation_no_key"]);
    // Sin meses esperando (antes del lanzamiento), no hay nada que decir.
    const idle = serviceWith({ stripe: null });
    expect(await idle.service.sweepReconciliations()).toBe(true);
    expect(idle.reported).toEqual([]);
  });

  it("un mes que se cerró entre medias no se reporta como vencido", async () => {
    const { service, reported } = serviceWith({ due: [{ period: 202_610, overdue: true }], window: { kind: "refused", answer: "closed" } });
    expect(await service.sweepReconciliations()).toBe(true);
    expect(reported).toEqual([]);
  });

  it("si la base no dice qué toca, la pasada no salió", async () => {
    const { service, reported } = serviceWith({ due: "throws" });
    expect(await service.sweepReconciliations()).toBe(false);
    expect(reported).toEqual(["billing_reconciliation_unavailable"]);
  });
});

describe("explicar una diferencia", () => {
  const form = { period: 202_610, side: "only_provider", charge: "ch_panel", cents: "50000", currency: "mxn", note: "  Cobro a mano en el panel.  " };

  it("revisa lo que llega y manda la nota recortada", async () => {
    const { service, calls } = serviceWith();
    expect(await service.explainDifference(reader, form)).toEqual({ kind: "answered", answer: "explained" });
    expect(calls).toEqual([
      "guarda",
      `explicar ${JSON.stringify({ period: 202_610, side: "only_provider", charge: "ch_panel", providerCents: 50_000, currency: "mxn", note: "Cobro a mano en el panel." })}`,
    ]);
  });

  it.each([
    ["un lado que no se explica", { side: "only_own" }],
    ["otro monto", { side: "amount" }],
    ["un cargo sin forma", { charge: "ch panel" }],
    ["un monto sin forma", { cents: "50000.5" }],
    ["una moneda en mayúsculas", { currency: "MXN" }],
    ["una nota vacía", { note: "   " }],
    ["una nota de más", { note: "x".repeat(EXPLAIN_NOTE_MAX + 1) }],
    ["un periodo que no es entero", { period: "202610" }],
  ])("%s no llega a la base", async (_name, change) => {
    const { service, calls } = serviceWith();
    expect(await service.explainDifference(reader, { ...form, ...change })).toEqual({ kind: "malformed" });
    expect(calls).toEqual(["guarda"]);
  });

  it("quien no tiene finanzas, no; y lo que la base no contesta de su lista es «no se supo»", async () => {
    expect(await serviceWith({ check: teamCheck(["content"]) }).service.explainDifference(reader, form)).toEqual({ kind: "refused" });
    const odd = serviceWith({ explain: "deleted" });
    expect(await odd.service.explainDifference(reader, form)).toEqual({ kind: "unknown" });
    expect(odd.reported).toEqual(["billing_reconciliation_unavailable"]);
  });
});
