import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { BeginAnswer, BeginInput, CheckoutRow, CloseAnswer, CreatingAnswer, Offer, RecordAnswer, StatusRow } from "./checkout";

// Lo que la salida a pagar le pregunta a la base (T-302; `t302_salida_a_pagar`). Las funciones `checkout_*` se nombran solo aquí. Todas corren como la persona por
// el servidor (`asServer`), salvo la oferta, que es la misma para el visitante y se lee como sistema.

const row = z
  .object({
    id: z.string(),
    plan: z.enum(["monthly", "annual"]),
    livemode: z.boolean(),
    lookup_key: z.string(),
    amount_cents: z.number().int(),
    next_charge_at: z.string(),
    expires_at: z.string(),
    return_to: z.string(),
    state: z.enum(["reserved", "creating", "open", "completed", "expired", "abandoned", "lapsed"]),
    session_id: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

const toRow = (r: z.infer<typeof row>): CheckoutRow => ({
  id: r.id,
  plan: r.plan,
  livemode: r.livemode,
  lookupKey: r.lookup_key,
  amountCents: r.amount_cents,
  nextChargeAt: r.next_charge_at,
  expiresAt: r.expires_at,
  returnTo: r.return_to,
  state: r.state,
  sessionId: r.session_id,
  url: r.url,
});

const offer = z.object({
  answer: z
    .object({
      plans: z.array(z.object({ plan: z.enum(["monthly", "annual"]), amount_cents: z.number().int(), lookup_key: z.string(), next_charge_at: z.string() }).strict()),
      recurring: z.object({ id: z.string(), version: z.number().int(), title: z.string(), body: z.string() }).strict().nullable(),
      refund_policy: z.string().nullable(),
      refund_days: z.number().int().nullable(),
    })
    .strict(),
});

export async function askOffer(tx: Tx): Promise<Offer> {
  const [r] = await tx.query(sql`select private.checkout_offer() as answer`, offer);
  if (!r) throw new Error("checkout_offer no contestó");
  const a = r.answer;
  return {
    plans: a.plans.map((p) => ({ plan: p.plan, amountCents: p.amount_cents, lookupKey: p.lookup_key, nextChargeAt: p.next_charge_at })),
    recurring: a.recurring,
    refundPolicy: a.refund_policy,
    refundDays: a.refund_days,
  };
}

const standing = z.object({ answer: z.object({ blocking: z.boolean(), open: row.nullable() }).strict().nullable() });

export async function askStanding(tx: Tx): Promise<{ blocking: boolean; open: CheckoutRow | null } | null> {
  const [r] = await tx.query(sql`select private.checkout_standing() as answer`, standing);
  if (!r?.answer) return null;
  return { blocking: r.answer.blocking, open: r.answer.open === null ? null : toRow(r.answer.open) };
}

const begun = z.object({
  answer: z.union([
    z.object({ answer: z.literal("not_allowed"), reason: z.enum(["no_actor", "suspended", "email_unverified"]) }).strict(),
    z.object({ answer: z.enum(["invalid", "in_progress", "unavailable", "changed"]) }).strict(),
    z.object({ answer: z.enum(["reuse", "open_other", "reserved"]), checkout: row, customer: z.string().nullable() }).strict(),
  ]),
});

export async function askBegin(tx: Tx, input: BeginInput): Promise<BeginAnswer> {
  const [r] = await tx.query(
    sql`select private.checkout_begin(${input.plan}::public.subscription_plan, ${input.amountSeen}::bigint, ${input.documentSeen}::uuid, ${input.livemode}::boolean,
                                      ${input.returnTo}, ${input.ip}::inet, ${input.userAgent}) as answer`,
    begun,
  );
  if (!r) throw new Error("checkout_begin no contestó");
  const a = r.answer;
  return "checkout" in a ? { answer: a.answer, checkout: toRow(a.checkout), customer: a.customer } : a;
}

const creating = z.object({
  answer: z.union([
    z.object({ answer: z.enum(["creating", "open"]), checkout: row }).strict(),
    z.object({ answer: z.enum(["closed", "stale", "not_found", "not_allowed"]) }).strict(),
  ]),
});

export async function askCreating(tx: Tx, checkout: string): Promise<CreatingAnswer> {
  const [r] = await tx.query(sql`select private.checkout_creating(${checkout}::uuid) as answer`, creating);
  if (!r) throw new Error("checkout_creating no contestó");
  return "checkout" in r.answer ? { answer: r.answer.answer, checkout: toRow(r.answer.checkout) } : r.answer;
}

const recorded = z.object({ answer: z.enum(["recorded", "conflict", "invalid", "not_found", "not_allowed"]) });

export async function askCustomerRecord(tx: Tx, livemode: boolean, customer: string): Promise<RecordAnswer> {
  const [r] = await tx.query(sql`select private.checkout_customer_record(${livemode}::boolean, ${customer}) as answer`, recorded);
  if (!r) throw new Error("checkout_customer_record no contestó");
  return r.answer;
}

export async function askSessionRecord(tx: Tx, checkout: string, session: string, url: string): Promise<RecordAnswer> {
  const [r] = await tx.query(sql`select private.checkout_session_record(${checkout}::uuid, ${session}, ${url}) as answer`, recorded);
  if (!r) throw new Error("checkout_session_record no contestó");
  return r.answer;
}

const closed = z.object({ answer: z.enum(["closed", "already_closed", "not_allowed", "invalid", "not_found"]) });

export async function askClose(tx: Tx, checkout: string, state: "abandoned" | "expired" | "completed", subscription: string | null): Promise<CloseAnswer> {
  const [r] = await tx.query(sql`select private.checkout_close(${checkout}::uuid, ${state}, ${subscription}) as answer`, closed);
  if (!r) throw new Error("checkout_close no contestó");
  return r.answer;
}

const status = z.object({
  answer: z.union([
    z.object({ mine: z.literal(false) }).strict(),
    row.extend({ mine: z.literal(true), subscription_id: z.string().nullable(), live: z.boolean() }).strict(),
  ]),
});

export async function askStatus(tx: Tx, session: string): Promise<StatusRow> {
  const [r] = await tx.query(sql`select private.checkout_status(${session}) as answer`, status);
  if (!r) throw new Error("checkout_status no contestó");
  const a = r.answer;
  if (!a.mine) return { mine: false };
  return { mine: true, id: a.id, state: a.state, returnTo: a.return_to, subscriptionId: a.subscription_id, live: a.live };
}
