import { z } from "zod";

import type { StripeGet } from "@/adapters/stripe/api";

import type { Applied, Claim, ClaimedEvent, Received, ReceivedEvent } from "./records";
import { checkStripeSignature } from "./signature";
import {
  invoicePlan,
  readInvoice,
  readInvoicePayments,
  readSubscription,
  type FailureSnapshot,
  type PaymentSnapshot,
  type Read,
  type SubscriptionSnapshot,
} from "./stripe-read";

// Los avisos de Stripe (T-303; RF-208; plan aprobado por Sergio el 2026-11-06). La ruta le pasa el cuerpo crudo y la firma; aquí se verifica, se guarda en la bandeja,
// se reclama y se procesa dentro de la misma petición, con un tope (decisión 2 de Sergio). Lo que contesta es lo que Stripe necesita saber: 200 si ya no tiene que
// reenviarlo (procesado, ignorado, en espera de T-307, fallido para siempre, repetido ya terminado, o un tipo que no es de cobro), 500 si falló de paso o se acabó el
// tiempo (Stripe lo reenvía, hasta 3 días en modo real, y el reenvío lo reclama otra vez), 400 con una firma mala o un aviso de cobro que no se entiende, 503 si la
// base no contestó al guardar. Nada lanza: lo que no se esperaba se reporta. Lo que sigue corriendo después del tope se devuelve aparte, para que la ruta lo deje
// terminar detrás de la respuesta. El barrido de cada día toma lo que quedó pendiente. Lo que finanzas reabre en PA-84 se procesa en el momento por el mismo camino
// (la tercera solicitud; FL-55 paso 3).

export type BillingFailure =
  | "stripe_signature_invalid"
  | "stripe_event_unreadable"
  | "stripe_wrong_mode"
  | "stripe_event_conflict"
  | "stripe_unavailable"
  | "stripe_key_rejected"
  | "billing_base_error"
  | "billing_event_failed"
  | "billing_event_late"
  | "billing_events_stuck"
  | "billing_body_too_large"
  | "billing_attempts_exhausted";

export interface BillingStore {
  receive: (event: ReceivedEvent) => Promise<Received>;
  claim: (id: string) => Promise<Claim>;
  claimDue: (limit: number) => Promise<ClaimedEvent[]>;
  /** Contesta si lo soltó: con el décimo intento, la base lo deja fallido. */
  release: (event: ClaimedEvent, code: string) => Promise<boolean>;
  finish: (event: ClaimedEvent, status: "ignored" | "deferred" | "failed", code: string | null) => Promise<boolean>;
  apply: (event: ClaimedEvent, subscription: SubscriptionSnapshot, payments: readonly PaymentSnapshot[], failure: FailureSnapshot | null) => Promise<Applied>;
  health: () => Promise<{ pending: number; failed: number; deferred: number; oldest_pending_at: string | null }>;
  /** Cuenta una entrega rechazada antes de la firma (firma mala, cuerpo de más) y contesta cuántas van en esta hora, con ella. */
  countRejection: () => Promise<number>;
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
  /** El tope del barrido, en milisegundos: lo que no alcance queda para el día siguiente o para el reenvío de Stripe. */
  sweepBudgetMs?: number;
}

/** Lo que contesta una entrega: el código HTTP y, si se acabó el tiempo, lo que sigue corriendo. */
export interface Delivery {
  status: number;
  rest?: Promise<void>;
}

/**
 * Cómo terminó un aviso que finanzas reabrió (PA-84): procesado, ya aplicado por otro aviso, otra vez fallido o de vuelta en la fila con su código, en camino porque
 * otro lo tomó, cambiado porque otro lo terminó, o todavía pendiente (pasó del tope y sigue detrás de la respuesta, o no se pudo reclamar: lo toma el barrido).
 */
export type ManualRun =
  | { kind: "processed" | "already_applied" | "busy" | "changed" | "still_pending" }
  | { kind: "failed" | "retry"; code: string };

const BUDGET_MS = 8_000;
// El barrido deja de reclamar a los 20 s: el último aviso, si es una factura de un pago, puede tardar otros 20 (cuatro lecturas de Stripe en cadena, de hasta
// 5 s cada una, y 5 s más por cada pago de más), y detrás vienen la revisión y el correo, dentro de los 60 s de la ruta. El correo manda hasta 20 por pasada, de
// hasta 10 s cada uno: con Resend lento no cabe todo, y lo que no salió queda apartado 10 minutos y sale en la siguiente pasada, sin duplicarse.
const SWEEP_BUDGET_MS = 20_000;
// Lo que cualquiera puede mandar sin firmar nada se cuenta y se reporta una vez por hora, al pasar de esto: así no llena el registro de errores.
const REJECTIONS_PER_HOUR = 5;
// Los intentos de un aviso: soltar el último lo deja fallido en la base (`provider_event_release`).
const MAX_ATTEMPTS = 10;

// Los tipos que la base aplica y los que esperan a T-307 (`private.billing_event_kind`). Lo demás se ignora. El punto de conexión se suscribe solo a estos.
const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);
const INVOICE_EVENTS = new Set(["invoice.paid", "invoice.payment_failed"]);
const isDeferred = (type: string) => type === "charge.refunded" || type.startsWith("charge.dispute.");
const isBilling = (type: string) => SUBSCRIPTION_EVENTS.has(type) || INVOICE_EVENTS.has(type) || isDeferred(type);

// Lo que se lee del cuerpo firmado: solo para guardar el aviso. Lo que se aplica se vuelve a leer de Stripe.
const eventBody = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  api_version: z.string().nullable().optional(),
  data: z.object({ object: z.object({ id: z.string() }) }),
});
const typeOnly = z.object({ type: z.string() });

type Outcome = "done" | "retry";

// Cómo terminó procesar un aviso. La entrega y el barrido solo miran si vuelve a la fila; reintentar a mano lo dice entero.
type Run =
  | { kind: "processed" | "already_applied" | "deferred" | "ignored" }
  | { kind: "failed" | "retry"; code: string };
const outcomeOf = (run: Run): Outcome => (run.kind === "retry" ? "retry" : "done");

export function createBillingInbox(deps: BillingInboxDeps) {
  const { store, report } = deps;

  /** Una entrega rechazada antes de la firma: se cuenta, y se reporta solo la que pasa del tope de la hora. Si no se pudo contar, se reporta. */
  async function noteRejection(code: "stripe_signature_invalid" | "billing_body_too_large"): Promise<void> {
    const hits = await store.countRejection().catch(() => null);
    if (hits === null || hits === REJECTIONS_PER_HOUR + 1) await report(code);
  }

  /** Lo devuelve a la fila. Si era su último intento, la base lo dejó fallido: nadie lo vería hasta el reporte del día. */
  async function release(event: ClaimedEvent, code: string): Promise<void> {
    const released = await store.release(event, code);
    if (released && event.attempt >= MAX_ATTEMPTS) await report("billing_attempts_exhausted");
  }

  async function settle(event: ClaimedEvent, read: Read<unknown> & { kind: "retry" | "failed" }): Promise<Run> {
    if (read.kind === "failed") {
      await store.finish(event, "failed", read.code);
      await report("billing_event_failed");
      return { kind: "failed", code: read.code };
    }
    await release(event, read.code);
    if (read.code === "provider_unavailable") await report("stripe_unavailable");
    if (read.code === "provider_unauthorized") await report("stripe_key_rejected");
    return { kind: "retry", code: read.code };
  }

  /** Lo que contestó `billing_apply`. Una factura con pagos que no registró ninguno ya estaba aplicada por otro aviso (FL-55 A1). */
  async function applied(answer: Applied, payments: number): Promise<Run> {
    switch (answer.outcome) {
      case "processed":
        return { kind: payments > 0 && answer.recorded === 0 ? "already_applied" : "processed" };
      case "failed":
        await report("billing_event_failed");
        return { kind: "failed", code: answer.code };
      case "retry":
        return { kind: "retry", code: answer.code };
      case "stale":
        return { kind: "retry", code: "stale" };
      case "deferred":
        return { kind: "deferred" };
    }
  }

  /** Aplica un aviso que esta entrega ya reclamó. */
  async function process(stripe: StripeGet, event: ClaimedEvent): Promise<Run> {
    const type = event.eventType;
    if (isDeferred(type)) {
      await store.finish(event, "deferred", "refund_waits_t307");
      return { kind: "deferred" };
    }
    if (SUBSCRIPTION_EVENTS.has(type)) {
      const subscription = await readSubscription(stripe, event.objectId, deps.now());
      if (subscription.kind !== "ok") return settle(event, subscription);
      return applied(await store.apply(event, subscription.value, [], null), 0);
    }
    if (!INVOICE_EVENTS.has(type)) {
      await store.finish(event, "ignored", null);
      return { kind: "ignored" };
    }

    // Una factura: se lee una vez, y su suscripción y sus pagos a la vez.
    const invoice = await readInvoice(stripe, event.objectId);
    if (invoice.kind !== "ok") return settle(event, invoice);
    if (type === "invoice.payment_failed") {
      const subscription = await readSubscription(stripe, invoice.value.subscription, deps.now());
      if (subscription.kind !== "ok") return settle(event, subscription);
      const failure: FailureSnapshot = {
        subscription: invoice.value.subscription,
        invoice: invoice.value.id,
        failed_at: event.occurredAt,
        unpaid: invoice.value.status !== "paid",
        cycle: invoice.value.billingReason === "subscription_cycle",
      };
      return applied(await store.apply(event, subscription.value, [], failure), 0);
    }
    if (invoice.value.status !== "paid") return settle(event, { kind: "failed", code: "invoice_not_paid" });
    // Una factura de 0 no tiene cobro: queda a la vista (decisión 7 de Sergio del 2026-11-06).
    if (invoice.value.amountPaid === 0) return settle(event, { kind: "failed", code: "zero_invoice" });
    const plan = invoicePlan(invoice.value);
    if (plan === null) return settle(event, { kind: "failed", code: "unknown_plan" });
    const [subscription, payments] = await Promise.all([
      readSubscription(stripe, invoice.value.subscription, deps.now()),
      readInvoicePayments(stripe, invoice.value, plan),
    ]);
    if (subscription.kind !== "ok") return settle(event, subscription);
    if (payments.kind !== "ok") return settle(event, payments);
    return applied(await store.apply(event, subscription.value, payments.value, null), payments.value.length);
  }

  /** Procesa un aviso reclamado, sin lanzar. Un error de la base o de quien sea deja el aviso en la fila. */
  async function processSafely(stripe: StripeGet, event: ClaimedEvent): Promise<Run> {
    try {
      return await process(stripe, event);
    } catch {
      await report("billing_base_error");
      await release(event, "base_error").catch(() => undefined);
      return { kind: "retry", code: "base_error" };
    }
  }

  /** Corre el trabajo hasta el tope de una entrega: lo que pase del tope sigue aparte. */
  async function withinBudget<T>(work: Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), deps.budgetMs ?? BUDGET_MS);
    });
    const first = await Promise.race([work.then((value) => ({ value })), late]);
    clearTimeout(timer);
    return first === "late" ? { done: false } : { done: true, value: first.value };
  }

  /** Una entrega de Stripe: el cuerpo crudo y la cabecera `Stripe-Signature`. */
  async function receiveStripeEvent(body: Uint8Array, signature: string | null): Promise<Delivery> {
    const secret = deps.secret();
    const stripe = deps.stripe();
    if (secret === null || stripe === null) return { status: 404 };
    // Sin la cabecera no es Stripe: no se reporta, para que nadie llene el registro de errores sin firmar nada.
    if (signature === null) return { status: 400 };
    if (checkStripeSignature(signature, body, secret, deps.now()) !== "valid") {
      await noteRejection("stripe_signature_invalid");
      return { status: 400 };
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      await report("stripe_event_unreadable");
      return { status: 400 };
    }
    const parsed = eventBody.safeParse(json);
    if (!parsed.success) {
      // Firmado, pero de un tipo que no es de cobro y con otra forma (un saldo, por ejemplo): no se guarda, y que Stripe no lo reenvíe.
      const kind = typeOnly.safeParse(json);
      if (kind.success && !isBilling(kind.data.type)) return { status: 200 };
      await report("stripe_event_unreadable");
      return { status: 400 };
    }
    const event = parsed.data;
    // Un aviso del otro modo no es de esta cuenta: no se guarda, y no se reenvía.
    if (event.livemode !== deps.live()) {
      await report("stripe_wrong_mode");
      return { status: 200 };
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
        return { status: 400 };
      }
      if (stored.outcome === "conflict") {
        await report("stripe_event_conflict");
        return { status: 200 };
      }
      if (stored.status !== "pending" && stored.status !== "processing") return { status: 200 };
      claim = await store.claim(stored.id);
    } catch {
      await report("billing_base_error");
      return { status: 503 };
    }
    if (claim.outcome === "finished") {
      // Un décimo intento que se cortó sin soltarse: lo agotó este reclamo.
      if (claim.exhausted === true) await report("billing_attempts_exhausted");
      return { status: 200 };
    }
    if (claim.outcome !== "claimed") return { status: 500 };

    const work = processSafely(stripe, claim.event);
    const first = await withinBudget(work);
    if (first.done) return { status: outcomeOf(first.value) === "done" ? 200 : 500 };
    // Se acabó el tiempo: Stripe lo reenvía, y lo que sigue termina detrás de la respuesta. Lo que escriba lo cuida el intento: un reenvío que lo reclame después no se
    // cruza con este.
    await report("billing_event_late");
    return { status: 500, rest: work.then(() => undefined) };
  }

  /**
   * Un aviso que finanzas acaba de reabrir (`provider_event_retry` contestó `retried`): se reclama por su id y se procesa ya, como sistema, con el tope de una entrega.
   * Stripe no lo reenvía (ya recibió 200), así que lo que pase del tope sigue aparte, detrás de la respuesta; si tampoco termina, lo toma el barrido.
   */
  async function processNow(id: string): Promise<{ result: ManualRun; rest?: Promise<void> }> {
    const stripe = deps.stripe();
    if (stripe === null) return { result: { kind: "still_pending" } };
    let claim: Claim;
    try {
      claim = await store.claim(id);
    } catch {
      await report("billing_base_error");
      return { result: { kind: "still_pending" } };
    }
    // Entre reabrirlo y reclamarlo lo tomó una entrega o el barrido (reabrir lo deja listo para ya): sigue en camino, sin gastar otro intento.
    if (claim.outcome === "busy") return { result: { kind: "busy" } };
    if (claim.outcome !== "claimed") return { result: { kind: "changed" } };
    const work = processSafely(stripe, claim.event);
    const first = await withinBudget(work);
    if (!first.done) return { result: { kind: "still_pending" }, rest: work.then(() => undefined) };
    const run = first.value;
    if (run.kind === "failed" || run.kind === "retry") return { result: run };
    return { result: { kind: run.kind === "already_applied" ? "already_applied" : "processed" } };
  }

  /** El barrido de respaldo: lo pendiente con su espera cumplida, hasta su tope. Contesta si pudo hablar con la base. Reporta lo que se quedó atorado. */
  async function sweepBillingEvents(): Promise<boolean> {
    const stripe = deps.stripe();
    if (stripe === null) return true;
    const deadline = deps.now().getTime() + (deps.sweepBudgetMs ?? SWEEP_BUDGET_MS);
    try {
      // De uno en uno hasta vaciar la fila o llegar al tope, para que un atraso (Stripe dejó de reenviar, o la llave estuvo mal) se drene en una pasada. Reclamar
      // gasta un intento, así que solo se reclama lo que se va a procesar: con un lote, lo que no alcanzara volvería a la fila con un intento gastado sin intentarlo.
      // Lo que vuelve a la fila con su espera (un minuto o más) no se reclama otra vez en la misma pasada.
      while (deps.now().getTime() <= deadline) {
        const [event] = await store.claimDue(1);
        if (event === undefined) break;
        await processSafely(stripe, event);
      }
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

  /** Un cuerpo de más del tope de la ruta: no se leyó, y cuenta como una firma mala. */
  const noteOversizedBody = (): Promise<void> => noteRejection("billing_body_too_large");

  return { receiveStripeEvent, sweepBillingEvents, noteOversizedBody, processNow };
}
