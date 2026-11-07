import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { FailureSnapshot, PaymentSnapshot, SubscriptionSnapshot } from "./stripe-read";

// Lo que la bandeja de los avisos le pregunta a la base, como sistema (T-303). Las funciones de `t303_bandeja` se nombran solo aquí: con ellas se registran cobros.

export interface ReceivedEvent {
  provider_event_id: string;
  event_type: string;
  livemode: boolean;
  api_version: string | null;
  object_id: string;
  occurred_at: string;
}

export type Received =
  | { outcome: "stored" | "duplicate"; id: string; status: string }
  | { outcome: "conflict"; id: string }
  | { outcome: "malformed" };

const received = z.object({
  answer: z.union([
    z.object({ outcome: z.enum(["stored", "duplicate"]), id: z.string(), status: z.string() }).strict(),
    z.object({ outcome: z.literal("conflict"), id: z.string() }).strict(),
    z.object({ outcome: z.literal("malformed") }).strict(),
  ]),
});

export async function askReceive(tx: Tx, event: ReceivedEvent): Promise<Received> {
  const rows = await tx.query(
    sql`select private.provider_event_receive('stripe', ${event.provider_event_id}, ${event.event_type}, ${event.livemode}::boolean, ${event.api_version},
                                              ${event.object_id}, ${event.occurred_at}::timestamptz) as answer`,
    received,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("provider_event_receive no contestó");
  return row.answer;
}

export interface ClaimedEvent {
  id: string;
  attempt: number;
  eventType: string;
  objectId: string;
  occurredAt: string;
}

const claimed = z.object({
  answer: z.union([
    z
      .object({ outcome: z.literal("claimed"), id: z.string(), attempt: z.number().int(), event_type: z.string(), object_id: z.string(), occurred_at: z.string() })
      .strict(),
    z.object({ outcome: z.literal("finished"), id: z.string(), status: z.string() }).strict(),
    z.object({ outcome: z.enum(["busy", "not_found"]), id: z.string() }).strict(),
  ]),
});

export type Claim = { outcome: "claimed"; event: ClaimedEvent } | { outcome: "finished" | "busy" | "not_found" };

export async function askClaim(tx: Tx, id: string): Promise<Claim> {
  const rows = await tx.query(sql`select private.provider_event_claim(${id}::uuid) as answer`, claimed);
  const answer = rows[0]?.answer;
  if (answer === undefined) throw new Error("provider_event_claim no contestó");
  if (answer.outcome !== "claimed") return { outcome: answer.outcome };
  return {
    outcome: "claimed",
    event: { id: answer.id, attempt: answer.attempt, eventType: answer.event_type, objectId: answer.object_id, occurredAt: answer.occurred_at },
  };
}

const dueRow = z.object({ id: z.string(), attempt: z.number().int(), event_type: z.string(), object_id: z.string(), occurred_at: z.date() }).strict();

export async function askClaimDue(tx: Tx, limit: number): Promise<ClaimedEvent[]> {
  const rows = await tx.query(sql`select id, attempt, event_type, object_id, occurred_at from private.provider_event_claim_due(${limit}::integer)`, dueRow);
  return rows.map((row) => ({ id: row.id, attempt: row.attempt, eventType: row.event_type, objectId: row.object_id, occurredAt: row.occurred_at.toISOString() }));
}

export async function askRelease(tx: Tx, id: string, attempt: number, code: string): Promise<void> {
  await tx.query(sql`select private.provider_event_release(${id}::uuid, ${attempt}::integer, ${code}) as answer`, z.object({ answer: z.boolean() }));
}

export async function askFinish(tx: Tx, id: string, attempt: number, status: "ignored" | "deferred" | "failed", code: string | null): Promise<boolean> {
  const rows = await tx.query(
    sql`select private.provider_event_finish(${id}::uuid, ${attempt}::integer, ${status}, ${code}) as answer`,
    z.object({ answer: z.boolean() }),
  );
  return rows[0]?.answer === true;
}

export type Applied =
  | { outcome: "processed"; subscription_id: string; recorded: number }
  | { outcome: "failed" | "retry"; code: string }
  | { outcome: "deferred" | "stale" };

const applied = z.object({
  answer: z.union([
    z.object({ outcome: z.literal("processed"), subscription_id: z.string(), recorded: z.number().int() }).strict(),
    z.object({ outcome: z.enum(["failed", "retry"]), code: z.string() }).strict(),
    z.object({ outcome: z.enum(["deferred", "stale"]) }).strict(),
  ]),
});

export async function askApply(
  tx: Tx,
  event: { id: string; attempt: number },
  subscription: SubscriptionSnapshot,
  payments: readonly PaymentSnapshot[],
  failure: FailureSnapshot | null,
): Promise<Applied> {
  const rows = await tx.query(
    sql`select private.billing_apply(${event.id}::uuid, ${event.attempt}::integer, ${JSON.stringify(subscription)}::jsonb, ${JSON.stringify(payments)}::jsonb,
                                     ${failure === null ? null : JSON.stringify(failure)}::jsonb) as answer`,
    applied,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("billing_apply no contestó");
  return row.answer;
}

const health = z.object({
  answer: z.object({ pending: z.number().int(), failed: z.number().int(), deferred: z.number().int(), oldest_pending_at: z.string().nullable() }).strict(),
});

export async function askHealth(tx: Tx): Promise<z.infer<typeof health>["answer"]> {
  const rows = await tx.query(sql`select private.provider_events_health() as answer`, health);
  const row = rows[0];
  if (row === undefined) throw new Error("provider_events_health no contestó");
  return row.answer;
}
