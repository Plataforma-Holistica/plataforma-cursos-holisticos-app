import { z } from "zod";

import type { StripeGet } from "@/adapters/stripe/api";

import type { Applied, Claim, ClaimedEvent, Received, ReceivedEvent } from "./records";
import { checkStripeSignature } from "./signature";
import { readChargeInvoice, readInvoice, readPaidInvoice, readSubscription, type FailureSnapshot, type PaymentSnapshot, type Read, type SubscriptionSnapshot } from "./stripe-read";

// Los avisos de Stripe (T-303; RF-208; plan aprobado por Sergio el 2026-11-06). La ruta le pasa el cuerpo crudo y la firma; aquí se verifica, se guarda en la bandeja,
// se reclama y se procesa dentro de la misma petición, con un tope (decisión 2 de Sergio). Lo que contesta es lo que Stripe necesita saber: 200 si ya no tiene que
// reenviarlo (procesado, ignorado, en espera de T-307, fallido para siempre o repetido ya terminado), 500 si falló de paso o se acabó el tiempo (Stripe lo reenvía,
// hasta 3 días en modo real, y el reenvío lo reclama otra vez), 400 con una firma mala o un cuerpo que no se entiende. Nada lanza: lo que no se esperaba se reporta.
// El barrido de cada día toma lo que quedó pendiente.

export type BillingFailure =
  | "stripe_signature_invalid"
  | "stripe_event_unreadable"
  | "stripe_wrong_mode"
  | "stripe_event_conflict"
  | "stripe_unavailable"
  | "billing_base_error"
  | "billing_event_failed"
  | "billing_events_stuck";

export interface BillingStore {
  receive: (event: ReceivedEvent) => Promise<Received>;
  claim: (id: string) => Promise<Claim>;
  claimDue: (limit: number) => Promise<ClaimedEvent[]>;
  release: (event: ClaimedEvent, code: string) => Promise<void>;
  finish: (event: ClaimedEvent, status: "ignored" | "deferred" | "failed", code: string | null) => Promise<boolean>;
  apply: (event: ClaimedEvent, subscription: SubscriptionSnapshot, payments: readonly PaymentSnapshot[], failure: FailureSnapshot | null) => Promise<Applied>;
  health: () => Promise<{ pending: number; failed: number; deferred: number; oldest_pending_at: string | null }>;
}

export interface BillingInboxDeps {
  store: BillingStore;
  /** Stripe, ya con su llave; nulo si no está configurado. */
  stripe: () => StripeGet | null;
  /** El secreto `whsec_` del punto de conexión; nulo si no está configurado. */
  secret: () => string | null;
  /** Si la llave es del modo real: un aviso del otro modo no se guarda. */
  live: () => boolean;
  now: () => Date;
  report: (code: BillingFailure) => Promise<void>;
  /** El tope de una entrega, en milisegundos. */
  budgetMs?: number;
}

const BUDGET_MS = 8_000;
const SWEEP_BATCH = 20;

// Lo que se lee del cuerpo firmado: solo para guardar el aviso. Lo que se aplica se vuelve a leer de Stripe.
const eventBody = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  api_version: z.string().nullable().optional(),
  data: z.object({ object: z.object({ id: z.string() }) }),
});

type Outcome = "done" | "retry";

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

export function createBillingInbox(deps: BillingInboxDeps) {
  const { store, report } = deps;

  async function fail(event: ClaimedEvent, code: string): Promise<Outcome> {
    await store.finish(event, "failed", code);
    await report("billing_event_failed");
    return "done";
  }

  async function settle(event: ClaimedEvent, read: Read<unknown> & { kind: "retry" | "failed" }): Promise<Outcome> {
    if (read.kind === "failed") return fail(event, read.code);
    await store.release(event, read.code);
    if (read.code === "provider_unavailable") await report("stripe_unavailable");
    return "retry";
  }

  async function applied(answer: Applied): Promise<Outcome> {
    if (answer.outcome === "failed") await report("billing_event_failed");
    return answer.outcome === "retry" || answer.outcome === "stale" ? "retry" : "done";
  }

  /** Aplica un aviso que esta entrega ya reclamó. */
  async function process(stripe: StripeGet, event: ClaimedEvent): Promise<Outcome> {
    const type = event.eventType;
    if (type === "charge.refunded" || type.startsWith("charge.dispute.")) {
      await store.finish(event, "deferred", "refund_waits_t307");
      return "done";
    }
    if (!SUBSCRIPTION_EVENTS.has(type) && type !== "invoice.paid" && type !== "invoice.payment_failed" && type !== "charge.updated") {
      await store.finish(event, "ignored", null);
      return "done";
    }

    let invoiceId: string | null = null;
    let subscriptionId: string;
    if (SUBSCRIPTION_EVENTS.has(type)) {
      subscriptionId = event.objectId;
    } else {
      invoiceId = event.objectId;
      if (type === "charge.updated") {
        const found = await readChargeInvoice(stripe, event.objectId);
        if (found.kind !== "ok") return settle(event, found);
        invoiceId = found.value;
      }
      const invoice = await readInvoiceSubscription(stripe, invoiceId);
      if (invoice.kind !== "ok") return settle(event, invoice);
      subscriptionId = invoice.value;
    }

    const subscription = await readSubscription(stripe, subscriptionId, deps.now());
    if (subscription.kind !== "ok") return settle(event, subscription);
    const plan = { interval: subscription.value.interval, interval_count: subscription.value.interval_count };

    if (type === "invoice.paid" || type === "charge.updated") {
      const paid = await readPaidInvoice(stripe, invoiceId!, plan);
      if (paid.kind !== "ok") return settle(event, paid);
      return applied(await store.apply(event, subscription.value, paid.value.payments, null));
    }
    if (type === "invoice.payment_failed") {
      const invoice = await readPaidInvoiceState(stripe, invoiceId!);
      if (invoice.kind !== "ok") return settle(event, invoice);
      const failure: FailureSnapshot = {
        subscription: subscriptionId,
        invoice: invoiceId!,
        failed_at: event.occurredAt,
        unpaid: invoice.value.unpaid,
        cycle: invoice.value.cycle,
      };
      return applied(await store.apply(event, subscription.value, [], failure));
    }
    return applied(await store.apply(event, subscription.value, [], null));
  }

  async function readInvoiceSubscription(stripe: StripeGet, invoiceId: string): Promise<Read<string>> {
    const state = await readPaidInvoiceState(stripe, invoiceId);
    return state.kind === "ok" ? { kind: "ok", value: state.value.subscription } : state;
  }

  /** Lo que una falla necesita de su factura: de qué suscripción es, si sigue sin pagar y si es de renovación. */
  async function readPaidInvoiceState(stripe: StripeGet, invoiceId: string): Promise<Read<{ subscription: string; unpaid: boolean; cycle: boolean }>> {
    const invoice = await readInvoice(stripe, invoiceId);
    if (invoice.kind !== "ok") return invoice;
    return {
      kind: "ok",
      value: { subscription: invoice.value.subscription, unpaid: invoice.value.status !== "paid", cycle: invoice.value.billing_reason === "subscription_cycle" },
    };
  }

  /** Procesa un aviso reclamado, sin lanzar. Un error de la base o de quien sea deja el aviso en la fila. */
  async function processSafely(stripe: StripeGet, event: ClaimedEvent): Promise<Outcome> {
    try {
      return await process(stripe, event);
    } catch {
      await report("billing_base_error");
      await store.release(event, "base_error").catch(() => undefined);
      return "retry";
    }
  }

  function within<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(late), ms);
      void work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(late);
        },
      );
    });
  }

  /** Una entrega de Stripe: el cuerpo crudo y la cabecera `Stripe-Signature`. Contesta el código HTTP. */
  async function receiveStripeEvent(body: Uint8Array, signature: string | null): Promise<number> {
    const secret = deps.secret();
    const stripe = deps.stripe();
    if (secret === null || stripe === null) return 404;
    const check = checkStripeSignature(signature, body, secret, deps.now());
    if (check !== "valid") {
      await report("stripe_signature_invalid");
      return 400;
    }
    let event: z.infer<typeof eventBody>;
    try {
      const parsed = eventBody.safeParse(JSON.parse(new TextDecoder().decode(body)));
      if (!parsed.success) throw new Error("unreadable");
      event = parsed.data;
    } catch {
      await report("stripe_event_unreadable");
      return 400;
    }
    // Un aviso del otro modo no es de esta cuenta: no se guarda, y no se reenvía.
    if (event.livemode !== deps.live()) {
      await report("stripe_wrong_mode");
      return 200;
    }
    let claim: Claim;
    try {
      const stored = await store.receive({
        provider_event_id: event.id,
        event_type: event.type,
        livemode: event.livemode,
        api_version: event.api_version ?? null,
        object_id: event.data.object.id,
        occurred_at: new Date(event.created * 1000).toISOString(),
      });
      if (stored.outcome === "malformed") {
        await report("stripe_event_unreadable");
        return 400;
      }
      if (stored.outcome === "conflict") {
        await report("stripe_event_conflict");
        return 200;
      }
      if (stored.status !== "pending" && stored.status !== "processing") return 200;
      claim = await store.claim(stored.id);
    } catch {
      await report("billing_base_error");
      return 503;
    }
    if (claim.outcome === "finished") return 200;
    if (claim.outcome !== "claimed") return 500;
    const outcome = await within(processSafely(stripe, claim.event), deps.budgetMs ?? BUDGET_MS, "retry" as Outcome);
    return outcome === "done" ? 200 : 500;
  }

  /** El barrido de respaldo: lo pendiente con su espera cumplida. Contesta si pudo hablar con la base. Reporta lo que se quedó atorado. */
  async function sweepBillingEvents(): Promise<boolean> {
    const stripe = deps.stripe();
    if (stripe === null) return true;
    try {
      const due = await store.claimDue(SWEEP_BATCH);
      for (const event of due) await processSafely(stripe, event);
      const now = await store.health();
      if (now.failed > 0 || (now.oldest_pending_at !== null && Date.parse(now.oldest_pending_at) < deps.now().getTime() - 24 * 60 * 60 * 1000)) {
        await report("billing_events_stuck");
      }
      return true;
    } catch {
      await report("billing_base_error");
      return false;
    }
  }

  return { receiveStripeEvent, sweepBillingEvents };
}
