import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { QUEUE_STATUSES, RESOLVE_ANSWERS, RETRY_ANSWERS, type BillingQueueData, type ResolveAnswer, type RetryAnswer } from "./queue";
import {
  EXPLAIN_ANSWERS,
  RECORD_ANSWERS,
  SETTLEMENT_ANSWERS,
  WINDOW_ANSWERS,
  type ExplainAnswer,
  type Explanation,
  type RecordAnswer,
  type Settlement,
  type SettlementAnswer,
  type StripeCharge,
  type WindowAnswer,
} from "./reconcile";
import type { FailureSnapshot, PaymentSnapshot, SubscriptionSnapshot } from "./stripe-read";

// Lo que la bandeja de los avisos le pregunta a la base, como sistema (T-303), y lo que finanzas lee y decide en PA-84, como la persona. Las funciones de `t303_bandeja` se nombran solo aquí: con ellas se registran cobros.

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
    z.object({ outcome: z.literal("finished"), id: z.string(), status: z.string(), exhausted: z.literal(true).optional() }).strict(),
    z.object({ outcome: z.enum(["busy", "not_found"]), id: z.string() }).strict(),
  ]),
});

/** `exhausted`: este reclamo lo dejó fallido por sus intentos (un décimo que se cortó sin soltarse). */
export type Claim = { outcome: "claimed"; event: ClaimedEvent } | { outcome: "finished"; exhausted?: boolean } | { outcome: "busy" | "not_found" };

export async function askClaim(tx: Tx, id: string): Promise<Claim> {
  const rows = await tx.query(sql`select private.provider_event_claim(${id}::uuid) as answer`, claimed);
  const answer = rows[0]?.answer;
  if (answer === undefined) throw new Error("provider_event_claim no contestó");
  if (answer.outcome === "finished") return answer.exhausted === true ? { outcome: "finished", exhausted: true } : { outcome: "finished" };
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

export async function askRelease(tx: Tx, id: string, attempt: number, code: string): Promise<boolean> {
  const rows = await tx.query(sql`select private.provider_event_release(${id}::uuid, ${attempt}::integer, ${code}) as answer`, z.object({ answer: z.boolean() }));
  return rows[0]?.answer === true;
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

const rejectionHits = z.object({ hits: z.number().int() }).strict();

/** Cuenta una entrega rechazada antes de la firma en el contador de la hora (`rate_limit_counters`, la ventana la pone la base) y contesta cuántas van. */
export async function askCountRejection(tx: Tx): Promise<number> {
  const rows = await tx.query(
    sql`insert into private.rate_limit_counters as c (bucket, window_start, hits)
        values ('stripe_webhook_rejected', date_trunc('hour', pg_catalog.now()), 1)
        on conflict (bucket, window_start) do update set hits = c.hits + 1
        returning hits`,
    rejectionHits,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("el contador de rechazos no contestó");
  return row.hits;
}

export async function askHealth(tx: Tx): Promise<z.infer<typeof health>["answer"]> {
  const rows = await tx.query(sql`select private.provider_events_health() as answer`, health);
  const row = rows[0];
  if (row === undefined) throw new Error("provider_events_health no contestó");
  return row.answer;
}

// Lo que lee y decide finanzas en PA-84 (la tercera solicitud), a nombre de la persona: la base pide la capacidad y, para decidir, el código reciente.

const queueEvent = z
  .object({
    id: z.string(),
    revision: z.number().int(),
    provider_event_id: z.string(),
    event_type: z.string(),
    livemode: z.boolean(),
    object_id: z.string(),
    occurred_at: z.string(),
    received_at: z.string(),
    status: z.enum(QUEUE_STATUSES),
    attempts: z.number().int(),
    next_attempt_at: z.string(),
    last_error: z.string().nullable(),
    is_self: z.boolean(),
  })
  .strict();
const queueList = z.object({
  answer: z.object({ fresh_code: z.boolean(), total: z.number().int(), events: z.array(queueEvent) }).strict().nullable(),
});

export async function askQueue(tx: Tx): Promise<BillingQueueData | null> {
  const rows = await tx.query(sql`select private.provider_events_list() as answer`, queueList);
  const answer = rows[0]?.answer;
  if (answer === undefined) throw new Error("provider_events_list no contestó");
  if (answer === null) return null;
  return {
    freshCode: answer.fresh_code,
    total: answer.total,
    events: answer.events.map((event) => ({
      id: event.id,
      revision: event.revision,
      providerEventId: event.provider_event_id,
      eventType: event.event_type,
      livemode: event.livemode,
      objectId: event.object_id,
      occurredAt: event.occurred_at,
      receivedAt: event.received_at,
      status: event.status,
      attempts: event.attempts,
      nextAttemptAt: event.next_attempt_at,
      lastError: event.last_error,
      isSelf: event.is_self,
    })),
  };
}

export async function askQueueCount(tx: Tx): Promise<number | null> {
  const rows = await tx.query(sql`select private.provider_events_count() as answer`, z.object({ answer: z.number().int().nullable() }));
  const row = rows[0];
  if (row === undefined) throw new Error("provider_events_count no contestó");
  return row.answer;
}

const outcome = z.object({ answer: z.object({ outcome: z.string() }).passthrough() });

export async function askRetry(tx: Tx, event: string, revision: number): Promise<RetryAnswer> {
  const rows = await tx.query(sql`select private.provider_event_retry(${event}::uuid, ${revision}::integer) as answer`, outcome);
  const answer = RETRY_ANSWERS.find((each) => each === rows[0]?.answer.outcome);
  if (answer === undefined) throw new Error("provider_event_retry contestó algo que no se conoce");
  return answer;
}

export async function askResolve(tx: Tx, event: string, note: string, revision: number): Promise<ResolveAnswer> {
  const rows = await tx.query(sql`select private.provider_event_resolve(${event}::uuid, ${note}, ${revision}::integer) as answer`, outcome);
  const answer = RESOLVE_ANSWERS.find((each) => each === rows[0]?.answer.outcome);
  if (answer === undefined) throw new Error("provider_event_resolve contestó algo que no se conoce");
  return answer;
}

// La conciliación con Stripe (T-303, cuarta solicitud). Sus funciones de `t303_conciliacion` se nombran solo aquí.

const anyAnswer = z.object({ answer: z.object({ outcome: z.string() }).passthrough().nullable() });

function known<Answer extends string>(list: readonly Answer[], value: unknown, fn: string): Answer {
  const answer = list.find((each) => each === value);
  if (answer === undefined) throw new Error(`${fn} contestó algo que no se conoce`);
  return answer;
}

const windowAnswer = z.object({ outcome: z.literal("window"), starts_at: z.number().int(), ends_at: z.number().int() });

export async function askReconcileWindow(tx: Tx, period: number): Promise<WindowAnswer> {
  const rows = await tx.query(sql`select private.billing_reconciliation_window(${period}::integer) as answer`, anyAnswer);
  const answer = rows[0]?.answer;
  if (answer === undefined || answer === null) throw new Error("billing_reconciliation_window no contestó");
  const window = windowAnswer.safeParse(answer);
  if (window.success) return { kind: "window", startsAt: window.data.starts_at, endsAt: window.data.ends_at };
  return { kind: "refused", answer: known(WINDOW_ANSWERS, answer.outcome, "billing_reconciliation_window") };
}

const recorded = z.object({ outcome: z.literal("recorded"), reconciliation_id: z.string(), matches: z.boolean(), differences: z.number().int() });

export async function askReconcileRecord(
  tx: Tx,
  period: number,
  livemode: boolean,
  startsAt: number,
  endsAt: number,
  complete: boolean,
  charges: StripeCharge[],
): Promise<RecordAnswer> {
  const rows = await tx.query(
    sql`select private.billing_reconciliation_record(${period}::integer, ${livemode}::boolean, ${startsAt}::bigint, ${endsAt}::bigint, ${complete}::boolean,
                                                     ${JSON.stringify(charges)}::jsonb) as answer`,
    anyAnswer,
  );
  const answer = rows[0]?.answer;
  if (answer === undefined || answer === null) throw new Error("billing_reconciliation_record no contestó");
  const done = recorded.safeParse(answer);
  if (done.success) return { kind: "recorded", id: done.data.reconciliation_id, matches: done.data.matches, differences: done.data.differences };
  return { kind: "refused", answer: known(RECORD_ANSWERS, answer.outcome, "billing_reconciliation_record") };
}

const reconcileDueRow = z.object({ period_id: z.number().int(), overdue: z.boolean() });

export async function askReconcileDue(tx: Tx): Promise<{ period: number; overdue: boolean }[]> {
  const rows = await tx.query(sql`select private.billing_reconciliation_due() as answer`, z.object({ answer: z.array(reconcileDueRow).nullable() }));
  const answer = rows[0]?.answer;
  if (answer === undefined || answer === null) throw new Error("billing_reconciliation_due no contestó");
  return answer.map((row) => ({ period: row.period_id, overdue: row.overdue }));
}

export async function askSettlementsMissing(tx: Tx, period: number): Promise<string[]> {
  const rows = await tx.query(sql`select private.billing_settlements_missing(${period}::integer) as answer`, z.object({ answer: z.array(z.string()).nullable() }));
  const answer = rows[0]?.answer;
  if (answer === undefined || answer === null) throw new Error("billing_settlements_missing no contestó");
  return answer;
}

export async function askSettlementComplete(tx: Tx, s: Settlement): Promise<SettlementAnswer> {
  const rows = await tx.query(
    sql`select private.billing_settlement_complete(${s.charge}, ${s.transaction}, ${s.grossCents}::bigint, ${s.feeCents}::bigint, ${s.netCents}::bigint,
                                                   ${s.availableOn}::timestamptz) as answer`,
    anyAnswer,
  );
  return known(SETTLEMENT_ANSWERS, rows[0]?.answer?.outcome, "billing_settlement_complete");
}

export async function askReconcileExplain(tx: Tx, e: Explanation): Promise<ExplainAnswer> {
  const rows = await tx.query(
    sql`select private.billing_reconciliation_explain(${e.period}::integer, ${e.side}, ${e.charge}, null::bigint, ${e.providerCents}::bigint, ${e.currency},
                                                      ${e.note}) as answer`,
    anyAnswer,
  );
  return known(EXPLAIN_ANSWERS, rows[0]?.answer?.outcome, "billing_reconciliation_explain");
}
