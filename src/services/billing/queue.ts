import "server-only";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { holds, type CodeGiven, type TeamCheck, type TeamStanding } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

import type { ManualRun } from "./inbox";

// La cola de los avisos de Stripe para finanzas (PA-84, FL-55; T-303, tercera solicitud). Quién puede lo decide la base, con la puerta de finanzas
// (`finance_change_gate`: la capacidad y un código reciente); aquí, como en las alertas de anomalía:
//
//   · La guarda va primero: `teamStanding`, y solo sigue quien es del equipo con finanzas. Los demás reciben `refused` sin preguntarle nada más a la base. Si no se
//     supo quién pide, `unavailable`.
//   · Lo que llega se revisa antes de tocar la base: el aviso con forma de identificador, la revisión vista como entero, y la nota con algo escrito y de 500 o menos.
//   · Reintentar lo reabre con la sesión de quien pide, y si la base lo reabrió, lo procesa en el momento como sistema (`processNow`): FL-55 paso 3.
//   · Lo que contesta la base se entiende contra su lista cerrada. Otra cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.

/** El tope de la nota de «Resolver a mano», el de la base. */
export const RESOLVE_NOTE_MAX = 500;

export const QUEUE_STATUSES = ["failed", "deferred", "pending", "processing"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export interface BillingQueueEvent {
  id: string;
  /** La que lleva cada acción: si cambió desde que se vio, la base contesta `changed`. */
  revision: number;
  providerEventId: string;
  eventType: string;
  livemode: boolean;
  objectId: string;
  occurredAt: string;
  receivedAt: string;
  status: QueueStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  /** El aviso del pago de quien mira: no se le ofrece nada. */
  isSelf: boolean;
}

export interface BillingQueueData {
  /** Las acciones pasarían hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  /** Cuántos hay, aunque no quepan todos. */
  total: number;
  /** Del más viejo al más nuevo en Stripe. */
  events: BillingQueueEvent[];
}

/** Lo que contesta `provider_event_retry`. */
export const RETRY_ANSWERS = ["retried", "changed", "self", "not_failed", "not_found", "forbidden", "needs_fresh_code"] as const;
export type RetryAnswer = (typeof RETRY_ANSWERS)[number];
/** Lo que contesta `provider_event_resolve`. */
export const RESOLVE_ANSWERS = ["resolved", "changed", "self", "not_failed", "not_found", "malformed", "forbidden", "needs_fresh_code"] as const;
export type ResolveAnswer = (typeof RESOLVE_ANSWERS)[number];

/**
 * Lo que este servicio le pregunta a la base, a nombre de las claims que se le pasan. La lista y la cuenta son nulas cuando quien actúa no pasa la puerta del equipo
 * con finanzas. Las acciones lanzan si la base no contestó algo de su lista: quien llama lo trata como «no se supo».
 */
export interface BillingQueueStore {
  list(claims: VerifiedClaims): Promise<BillingQueueData | null>;
  count(claims: VerifiedClaims): Promise<number | null>;
  retry(claims: VerifiedClaims, event: string, revision: number): Promise<RetryAnswer>;
  resolve(claims: VerifiedClaims, event: string, note: string, revision: number): Promise<ResolveAnswer>;
}

type Refused = { kind: "refused" };
type Unavailable = { kind: "unavailable" };
type Unknown = { kind: "unknown" };
type Malformed = { kind: "malformed" };

export type QueueRead = { kind: "queue"; queue: BillingQueueData } | Unavailable;
export type QueueCount = { kind: "count"; count: number } | { kind: "none" } | Unavailable;
/** `ran`: la base lo reabrió y se procesó (o sigue, con `rest`). Si no lo reabrió, `answered` con el porqué. */
export type EventRetried =
  | Refused
  | Unavailable
  | Unknown
  | Malformed
  | { kind: "answered"; answer: Exclude<RetryAnswer, "retried"> }
  | { kind: "ran"; run: ManualRun; rest?: Promise<void> };
export type EventResolved = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: ResolveAnswer };
export type BillingCode =
  | Refused
  | Unavailable
  | { kind: "verified" }
  | { kind: "wrong_code" }
  | { kind: "throttled" }
  /** Su código fue el bueno, y aun así ninguna acción pasaría. */
  | { kind: "not_available" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^(0|[1-9][0-9]{0,9})$/;

const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);
function revisionOf(value: unknown): number | null {
  if (typeof value !== "string" || !REVISION.test(value)) return null;
  const revision = Number(value);
  return revision <= 2_147_483_647 ? revision : null;
}
function noteOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > RESOLVE_NOTE_MAX ? null : trimmed;
}

export interface BillingQueueCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  giveSecondFactorCode: (jar: CookieJar, code: string) => Promise<CodeGiven>;
  store: BillingQueueStore;
  /** Procesa ya, como sistema, un aviso que se acaba de reabrir (`createBillingInbox`). */
  processNow: (event: string) => Promise<{ result: ManualRun; rest?: Promise<void> }>;
}

export function createBillingQueue(deps: { report: (code: FailureCode) => Promise<void> }, core: BillingQueueCore) {
  const { store } = core;

  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "finance")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /** Una acción: lo que la base contestó, si es de su lista; si no, o si no contestó, «no se supo». */
  async function decide<Answer extends string>(
    known: readonly Answer[],
    work: () => Promise<Answer>,
  ): Promise<{ ok: true; answer: Answer } | { ok: false; result: Unknown }> {
    try {
      const answer = await work();
      if (known.includes(answer)) return { ok: true, answer };
    } catch {
      // Abajo.
    }
    await deps.report("billing_queue_unavailable");
    return { ok: false, result: { kind: "unknown" } };
  }

  /** La cola, para la sección que ya pasó su guarda. Una lectura nula se le vuelve a preguntar a la guarda, y solo si insiste se reporta. */
  async function billingQueue(reader: CookieReader, claims: VerifiedClaims): Promise<QueueRead> {
    let queue: BillingQueueData | null;
    try {
      queue = await store.list(claims);
    } catch {
      await deps.report("billing_queue_unavailable");
      return { kind: "unavailable" };
    }
    if (queue !== null) return { kind: "queue", queue };
    const team = await core.teamStanding(reader);
    if (team.kind === "team" && holds(team.standing, "finance")) await deps.report("billing_queue_unavailable");
    return { kind: "unavailable" };
  }

  /** La tarjeta del inicio de administración (PA-60): cuántos fallidos. Quien no tiene finanzas no la lee. */
  async function billingQueueCount(claims: VerifiedClaims, standing: TeamStanding): Promise<QueueCount> {
    if (!holds(standing, "finance")) return { kind: "none" };
    let count: number | null;
    try {
      count = await store.count(claims);
    } catch {
      count = null;
    }
    if (count !== null) return { kind: "count", count };
    await deps.report("billing_queue_unavailable");
    return { kind: "unavailable" };
  }

  /** «Reintentar» (RF-710): con la revisión que se vio. Si la base lo reabre, se procesa ya. */
  async function retryBillingEvent(reader: CookieReader, input: { event: unknown; revision: unknown }): Promise<EventRetried> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const event = idOf(input.event);
    const revision = revisionOf(input.revision);
    if (event === null || revision === null) return { kind: "malformed" };
    const result = await decide(RETRY_ANSWERS, () => store.retry(admitted.claims, event, revision));
    if (!result.ok) return result.result;
    if (result.answer !== "retried") return { kind: "answered", answer: result.answer };
    const { result: run, rest } = await core.processNow(event);
    return rest === undefined ? { kind: "ran", run } : { kind: "ran", run, rest };
  }

  /** «Resolver a mano» (decisión 6 de Sergio): con la nota, de 1 a 500, y la revisión que se vio. */
  async function resolveBillingEvent(reader: CookieReader, input: { event: unknown; revision: unknown; note: unknown }): Promise<EventResolved> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const event = idOf(input.event);
    const revision = revisionOf(input.revision);
    const note = noteOf(input.note);
    if (event === null || revision === null || note === null) return { kind: "malformed" };
    const result = await decide(RESOLVE_ANSWERS, () => store.resolve(admitted.claims, event, note, revision));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /** Dar el código otra vez (PA-84, «Tu código»): se comprueba con la cola, que pide finanzas. */
  async function giveBillingCode(jar: CookieJar, code: string): Promise<BillingCode> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const given = await core.giveSecondFactorCode(jar, code);
    switch (given.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
      case "unavailable":
        return { kind: given.kind };
      default:
        return { kind: "refused" };
    }
    const again = await admit(jar);
    if (!again.ok) return again.result;
    let queue: BillingQueueData | null;
    try {
      queue = await store.list(again.claims);
    } catch {
      await deps.report("billing_queue_unavailable");
      return { kind: "not_available" };
    }
    if (queue === null) return { kind: "refused" };
    if (queue.freshCode) return { kind: "verified" };
    await deps.report("billing_queue_unavailable");
    return { kind: "not_available" };
  }

  return { billingQueue, billingQueueCount, retryBillingEvent, resolveBillingEvent, giveBillingCode };
}
