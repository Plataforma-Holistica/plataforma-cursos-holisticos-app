import "server-only";

import { z } from "zod";

import type { StripeGet } from "@/adapters/stripe/api";
import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

// La conciliación con Stripe (T-303, cuarta solicitud; RF-208, RF-501; plan aprobado por Sergio el 2026-11-08). El servidor lista los cargos de Stripe de la ventana
// del periodo y los manda tal como los leyó; la base los clasifica, los compara con el libro y guarda la comparación con cada diferencia. Aquí no se decide qué
// cargo cuenta: un error al leer el monto no puede afectar a los dos lados por igual, y por eso los cargos se leen con su propio esquema, no con el de
// `stripe-read.ts`.
//
//   · La ventana se parte por día y los días se listan a la par, de cuatro en cuatro, con un tope total de tiempo. Lo que no se alcanzó a listar, o una lectura que
//     Stripe no contestó, deja la comparación incompleta: se registra igual, y no coincide.
//   · Después se completa lo que liquidó Stripe para los cobros del periodo que llegaron sin su transacción de saldo (decisión 4 de Sergio). Lo que no alcance queda
//     para la siguiente pasada; nunca frena el cierre.
//   · El trabajo de cada día compara lo que pide la base (`billing_reconciliation_due`), y finanzas compara desde PA-79 («Comparar ahora», sin código reciente) y
//     explica una diferencia con nota (con código reciente).

/** El tope de la nota que explica una diferencia, el de la base. */
export const EXPLAIN_NOTE_MAX = 500;

const DAY_SECONDS = 86_400;
const CONCURRENCY = 4;
/** El tope de una lista: deja lugar a registrar y a completar lo que liquidó Stripe dentro de los 60 s de la ruta o de la acción. */
export const LIST_BUDGET_MS = 40_000;
/** El tope de toda la pasada del trabajo de cada día, para todos los meses que pide: cada uno recibe lo que quede. */
export const SWEEP_BUDGET_MS = 50_000;
/** Lo mínimo que tiene que quedar de la pasada para empezar otro mes: con menos, quedaría incompleto. */
export const MONTH_MIN_MS = 25_000;

export interface StripeCharge {
  id: string;
  status: string;
  captured: boolean;
  /** Se devolvió entero: una autorización sin capturar que venció queda así, y no es dinero. */
  refunded: boolean;
  currency: string;
  livemode: boolean;
  created: number;
  amount_captured: number;
}

// Solo lo que la base necesita, con su forma. Lo demás del cargo no viaja.
const chargeBody = z.object({
  id: z.string(),
  status: z.string(),
  captured: z.boolean(),
  refunded: z.boolean(),
  currency: z.string(),
  livemode: z.boolean(),
  created: z.number().int(),
  amount_captured: z.number().int(),
});
const listBody = z.object({ data: z.array(chargeBody), has_more: z.boolean() });
const settledBody = z.object({
  id: z.string(),
  currency: z.string(),
  balance_transaction: z
    .union([
      z.string(),
      z.object({ id: z.string(), amount: z.number().int(), fee: z.number().int(), net: z.number().int(), currency: z.string(), available_on: z.number().int() }),
    ])
    .nullable()
    .optional(),
});

export type Listed = { complete: boolean; charges: StripeCharge[]; failure: FailureCode | null };

/** Lista los cargos de `[starts, ends)` (segundos), por días a la par. Nunca lanza: lo que no se pudo leer deja el listado incompleto. */
export async function listCharges(get: StripeGet, starts: number, ends: number, deadline: number, now: () => number): Promise<Listed> {
  const days: [number, number][] = [];
  for (let from = starts; from < ends; from += DAY_SECONDS) days.push([from, Math.min(from + DAY_SECONDS, ends)]);
  const seen = new Map<string, StripeCharge>();
  let complete = true;
  let failure: FailureCode | null = null;

  async function day([from, to]: [number, number]): Promise<void> {
    let after: string | null = null;
    for (;;) {
      if (now() >= deadline) {
        complete = false;
        return;
      }
      const query: Record<string, string> = { "created[gte]": String(from), "created[lt]": String(to), limit: "100" };
      if (after !== null) query.starting_after = after;
      const answer = await get("/v1/charges", query);
      if (answer.status !== "ok") {
        complete = false;
        failure ??= answer.status === "unauthorized" ? "stripe_key_rejected" : "billing_reconciliation_unavailable";
        return;
      }
      const page = listBody.safeParse(answer.body);
      if (!page.success) {
        complete = false;
        failure ??= "billing_reconciliation_unavailable";
        return;
      }
      for (const charge of page.data.data) if (!seen.has(charge.id)) seen.set(charge.id, charge);
      if (!page.data.has_more) return;
      // Una página vacía que dice que hay más no se puede seguir: no se adivina que terminó.
      const last = page.data.data.at(-1);
      if (last === undefined) {
        complete = false;
        failure ??= "billing_reconciliation_unavailable";
        return;
      }
      after = last.id;
    }
  }

  const queue = [...days];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await day(next);
    }),
  );
  return { complete, charges: [...seen.values()], failure };
}

/** Quién compara: el trabajo de cada día, o una persona de finanzas con sus claims. */
export type Actor = { kind: "system" } | { kind: "person"; claims: VerifiedClaims };

// La ventana también frena a una persona que pide antes de un minuto, para no listar Stripe en balde.
export const WINDOW_ANSWERS = ["forbidden", "not_found", "closed", "too_early", "rate_limited"] as const;
export type WindowRefusal = (typeof WINDOW_ANSWERS)[number];
export type WindowAnswer = { kind: "window"; startsAt: number; endsAt: number } | { kind: "refused"; answer: WindowRefusal };

export const RECORD_ANSWERS = ["forbidden", "not_found", "closed", "too_early", "malformed", "rate_limited"] as const;
export type RecordRefusal = (typeof RECORD_ANSWERS)[number];
export type RecordAnswer = { kind: "recorded"; id: string; matches: boolean; differences: number } | { kind: "refused"; answer: RecordRefusal };

export const EXPLAIN_ANSWERS = [
  "explained",
  "exists",
  "not_explainable",
  "not_in_comparison",
  "closed",
  "not_found",
  "malformed",
  "forbidden",
  "needs_fresh_code",
] as const;
export type ExplainAnswer = (typeof EXPLAIN_ANSWERS)[number];

export const SETTLEMENT_ANSWERS = ["recorded", "exists", "mismatch", "not_found", "malformed", "forbidden"] as const;
export type SettlementAnswer = (typeof SETTLEMENT_ANSWERS)[number];

export interface Settlement {
  charge: string;
  transaction: string;
  grossCents: number;
  feeCents: number;
  netCents: number;
  availableOn: string | null;
}

/** Lo que este servicio le pregunta a la base. Cada pregunta lanza si la base contestó otra cosa que su lista: quien llama lo trata como «no se supo». */
export interface ReconcileStore {
  window(actor: Actor, period: number): Promise<WindowAnswer>;
  record(actor: Actor, period: number, livemode: boolean, startsAt: number, endsAt: number, complete: boolean, charges: StripeCharge[]): Promise<RecordAnswer>;
  /** Los meses terminados sin una comparación vigente; `overdue`: pasaron dos días de su fin. */
  due(): Promise<{ period: number; overdue: boolean }[]>;
  settlementsMissing(actor: Actor, period: number): Promise<string[]>;
  completeSettlement(actor: Actor, settlement: Settlement): Promise<SettlementAnswer>;
  explain(claims: VerifiedClaims, explanation: Explanation): Promise<ExplainAnswer>;
}

export interface Explanation {
  period: number;
  side: "only_provider" | "other_currency";
  charge: string;
  providerCents: number;
  currency: string;
  note: string;
}

/** Una comparación: `recorded` (con si coincide), `refused` con la respuesta de la base, `no_stripe` sin la llave, o `unknown`. */
export type Compared =
  | { kind: "recorded"; matches: boolean; complete: boolean; differences: number }
  | { kind: "refused"; answer: WindowRefusal | RecordRefusal }
  | { kind: "no_stripe" }
  | { kind: "unknown" };

type Refused = { kind: "refused" };
type Unavailable = { kind: "unavailable" };

export type CompareNow = Refused | Unavailable | { kind: "compared"; result: Compared };
export type Explained = Refused | Unavailable | { kind: "malformed" } | { kind: "unknown" } | { kind: "answered"; answer: ExplainAnswer };

export interface ReconcileCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  store: ReconcileStore;
  stripe: () => StripeGet | null;
  live: () => boolean;
  now: () => number;
}

const CHARGE = /^[!-~]{1,255}$/;
const CURRENCY = /^[a-z]{3}$/;
const CENTS = /^(0|[1-9][0-9]{0,11})$/;

export function createReconciliation(deps: { report: (code: FailureCode) => Promise<void> }, core: ReconcileCore) {
  const { store } = core;

  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "finance")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /** Completa lo que liquidó Stripe para los cobros del periodo que llegaron sin él, hasta el tope. Nunca lanza ni frena. */
  async function settle(get: StripeGet, actor: Actor, period: number, deadline: number): Promise<void> {
    let missing: string[];
    try {
      missing = await store.settlementsMissing(actor, period);
    } catch {
      await deps.report("billing_reconciliation_unavailable");
      return;
    }
    const queue = [...missing];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let charge = queue.shift(); charge !== undefined && core.now() < deadline; charge = queue.shift()) {
          const answer = await get(`/v1/charges/${charge}`, { "expand[]": ["balance_transaction"] });
          if (answer.status !== "ok") continue;
          const body = settledBody.safeParse(answer.body);
          const bt = body.success ? body.data.balance_transaction : null;
          if (!body.success || bt === null || bt === undefined || typeof bt === "string" || bt.currency !== body.data.currency) continue;
          try {
            const answer = await store.completeSettlement(actor, {
              charge,
              transaction: bt.id,
              grossCents: bt.amount,
              feeCents: bt.fee,
              netCents: bt.net,
              availableOn: new Date(bt.available_on * 1000).toISOString(),
            });
            // Otro bruto que el del cobro: no se guarda, y alguien tiene que mirarlo.
            if (answer === "mismatch") await deps.report("billing_settlement_mismatch");
          } catch {
            await deps.report("billing_reconciliation_unavailable");
            return;
          }
        }
      }),
    );
  }

  /** Compara un periodo: pide la ventana, lista y registra. Después completa lo que liquidó Stripe. `end`: el tope de la pasada entera, si lo hay. */
  async function compare(actor: Actor, period: number, end = Number.POSITIVE_INFINITY, settleMs = 10_000): Promise<Compared> {
    const get = core.stripe();
    if (get === null) return { kind: "no_stripe" };
    const deadline = Math.min(core.now() + LIST_BUDGET_MS, end - 10_000);
    try {
      const window = await store.window(actor, period);
      if (window.kind === "refused") return window;
      const listed = await listCharges(get, window.startsAt, window.endsAt, deadline, core.now);
      if (listed.failure !== null) await deps.report(listed.failure);
      const recorded = await store.record(actor, period, core.live(), window.startsAt, window.endsAt, listed.complete, listed.charges);
      if (recorded.kind === "refused") {
        // Una forma que la base rechaza es un error de este lado (o de Stripe): no debería pasar.
        if (recorded.answer === "malformed") await deps.report("billing_reconciliation_rejected");
        return recorded;
      }
      await settle(get, actor, period, Math.min(deadline + settleMs, end));
      return { kind: "recorded", matches: recorded.matches, complete: listed.complete, differences: recorded.differences };
    } catch {
      await deps.report("billing_reconciliation_unavailable");
      return { kind: "unknown" };
    }
  }

  return {
    /** El trabajo de cada día: compara cada periodo terminado y sin cerrar que no tiene una comparación vigente. Contesta si la pasada salió entera. */
    async sweepReconciliations(): Promise<boolean> {
      const end = core.now() + SWEEP_BUDGET_MS;
      let due: { period: number; overdue: boolean }[];
      try {
        due = await store.due();
      } catch {
        await deps.report("billing_reconciliation_unavailable");
        return false;
      }
      if (due.length === 0) return true;
      // Sin la llave ningún mes se puede cerrar: se dice cada día que haya alguno esperando.
      if (core.stripe() === null) {
        await deps.report("billing_reconciliation_no_key");
        return false;
      }
      let whole = true;
      for (const { period, overdue } of due) {
        // Lo que no alcanza queda para mañana, sin registrar nada; no es una falla. Si ya lleva dos días, se dice.
        if (core.now() >= end - MONTH_MIN_MS) {
          if (overdue) await deps.report("billing_reconciliation_overdue");
          continue;
        }
        const result = await compare({ kind: "system" }, period, end);
        if (result.kind === "unknown") whole = false;
        if (result.kind === "recorded" && !result.complete) await deps.report("billing_reconciliation_incomplete");
        else if (result.kind === "recorded" && !result.matches) await deps.report("billing_reconciliation_mismatch");
        // La alerta del 05: un mes terminado hace dos días sin una comparación vigente.
        // Uno que se cerró entre medias ya no espera nada.
        const closed = result.kind === "refused" && result.answer === "closed";
        if (overdue && !closed && !(result.kind === "recorded" && result.matches)) await deps.report("billing_reconciliation_overdue");
      }
      return whole;
    },

    /** «Comparar ahora» de PA-79, en el momento. Solo finanzas; no pide código reciente: no cambia dinero. */
    async compareNow(reader: CookieReader, period: number): Promise<CompareNow> {
      const admitted = await admit(reader);
      if (!admitted.ok) return admitted.result;
      // En la acción, lo que liquidó Stripe tiene 5 s: lo que no alcance lo completa el trabajo de cada día, y la acción cabe en sus 60 s.
      return { kind: "compared", result: await compare({ kind: "person", claims: admitted.claims }, period, Number.POSITIVE_INFINITY, 5_000) };
    },

    /** Explicar una diferencia de lo que Stripe cobró y el libro no tiene, con nota. Lo revisa todo antes de la base. */
    async explainDifference(reader: CookieReader, form: Readonly<Record<string, unknown>>): Promise<Explained> {
      const admitted = await admit(reader);
      if (!admitted.ok) return admitted.result;
      const { period, side, charge, cents, currency, note } = form;
      const trimmed = typeof note === "string" ? note.trim() : "";
      if (
        typeof period !== "number" ||
        !Number.isInteger(period) ||
        (side !== "only_provider" && side !== "other_currency") ||
        typeof charge !== "string" ||
        !CHARGE.test(charge) ||
        typeof cents !== "string" ||
        !CENTS.test(cents) ||
        typeof currency !== "string" ||
        !CURRENCY.test(currency) ||
        trimmed === "" ||
        trimmed.length > EXPLAIN_NOTE_MAX
      ) {
        return { kind: "malformed" };
      }
      try {
        const answer = await store.explain(admitted.claims, { period, side, charge, providerCents: Number(cents), currency, note: trimmed });
        if (EXPLAIN_ANSWERS.includes(answer)) return { kind: "answered", answer };
      } catch {
        // Abajo.
      }
      await deps.report("billing_reconciliation_unavailable");
      return { kind: "unknown" };
    },
  };
}
