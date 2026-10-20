// La cola de tramos de una reproducción, como la guarda el navegador (RF-401, RNF-05; T-205).
// Reglas puras: la pantalla de la lección guarda la cola en `localStorage` con su llave, la lee
// de vuelta con `parseQueue`, saca de ella cada lote y la ajusta con lo que contestó el servidor.
// Guardarla, los candados entre pestañas y los temporizadores viven en la pantalla.
//
// Cada reproducción numera sus tramos desde 0 (`seq`): la base no cuenta dos veces un
// consecutivo que ya recibió, así que reenviar es seguro. La cola no guarda títulos ni nombres:
// solo el identificador de la reproducción, en la llave, y segundos del video.

import { HEARTBEAT_LIMITS, parseHeartbeatEvent, type HeartbeatEvent } from "./heartbeat";
import type { Segment } from "./segments";

export const QUEUE_PREFIX = "plataforma-latidos:";

/** Una cola que no se escribe en siete días ya no se manda: la base no aceptaría tanto atraso. */
export const QUEUE_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export interface WatchQueue {
  v: 1;
  /** Cuándo se escribió por última vez, en milisegundos de la hora del navegador. */
  touched: number;
  /** El consecutivo que lleva el siguiente tramo. */
  next: number;
  events: HeartbeatEvent[];
}

/** Lo que contestó el servidor de un lote (el `BatchAnswer` de los medios). */
export type BatchVerdict = { kind: "settled"; seqs: readonly number[] } | { kind: "discard" } | { kind: "retry" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["v", "touched", "next", "events"];

export const queueKey = (sessionId: string): string => `${QUEUE_PREFIX}${sessionId}`;

/** La reproducción de una llave de la cola, o nulo si la llave no es de la cola. */
export function queueSessionOf(key: string): string | null {
  if (!key.startsWith(QUEUE_PREFIX)) return null;
  const id = key.slice(QUEUE_PREFIX.length);
  return UUID.test(id) ? id : null;
}

export const emptyQueue = (now: number): WatchQueue => ({ v: 1, touched: now, next: 0, events: [] });

/** Lo guardado, si tiene la forma exacta y no venció; si no, nulo, y quien la lee borra la llave. */
export function parseQueue(text: string | null, now: number): WatchQueue | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) return null;
  const { v, touched, next, events } = value as Record<string, unknown>;
  if (v !== 1 || typeof touched !== "number" || !Number.isFinite(touched) || now - touched > QUEUE_LIFE_MS) return null;
  if (!Number.isInteger(next) || (next as number) < 0 || (next as number) > HEARTBEAT_LIMITS.seq + 1 || !Array.isArray(events)) return null;
  const parsed: HeartbeatEvent[] = [];
  let previous = -1;
  for (const each of events) {
    const event = parseHeartbeatEvent(each);
    // Crecientes y menores que `next`: así los escribe `enqueue`.
    if (event === null || event.seq <= previous || event.seq >= (next as number)) return null;
    parsed.push(event);
    previous = event.seq;
  }
  return { v: 1, touched, next: next as number, events: parsed };
}

/** Agrega los tramos cerrados con sus consecutivos. Uno sin la forma que acepta la base no entra. */
export function enqueue(queue: WatchQueue, segments: readonly Segment[], now: number): WatchQueue {
  let next = queue.next;
  const added: HeartbeatEvent[] = [];
  for (const segment of segments) {
    // Pasado el tope de consecutivos, la regla del tramo ya no lo acepta: no se agrega nada más.
    const event = parseHeartbeatEvent({ seq: next, from: segment.from, to: segment.to, rate: segment.rate, visible: segment.visible });
    if (event === null) continue;
    added.push(event);
    next += 1;
  }
  if (added.length === 0) return queue;
  return { v: 1, touched: now, next, events: [...queue.events, ...added] };
}

/** Quita esos consecutivos. */
export function settle(queue: WatchQueue, seqs: readonly number[], now: number): WatchQueue {
  const gone = new Set(seqs);
  const events = queue.events.filter((event) => !gone.has(event.seq));
  return events.length === queue.events.length ? queue : { ...queue, touched: now, events };
}

/** El siguiente lote: los primeros que no van ya en camino, a lo más los que caben en uno. */
export function batchOf(queue: WatchQueue, sending: ReadonlySet<number>): HeartbeatEvent[] {
  return queue.events.filter((event) => !sending.has(event.seq)).slice(0, HEARTBEAT_LIMITS.batch);
}

/**
 * La cola después de la respuesta de un lote: lo resuelto sale (aceptado, repetido o rechazado:
 * reenviarlo no cambiaría nada), lo que se tira sale entero, y con «reintenta» o sin respuesta se
 * queda todo para el siguiente envío.
 */
export function resolveBatch(queue: WatchQueue, sent: readonly HeartbeatEvent[], verdict: BatchVerdict | null, now: number): WatchQueue {
  if (verdict === null || verdict.kind === "retry") return queue;
  const seqs = sent.map((event) => event.seq);
  if (verdict.kind === "discard") return settle(queue, seqs, now);
  const resolved = new Set(verdict.seqs);
  return settle(
    queue,
    seqs.filter((seq) => resolved.has(seq)),
    now,
  );
}

/** Cuánto espera el siguiente vaciado después de `failures` seguidos: 5, 10, 20 s, y el latido. */
export function retryDelaySeconds(failures: number, heartbeatSeconds: number): number {
  const doubled = 5 * 2 ** Math.max(Math.min(failures, 10) - 1, 0);
  return Math.min(doubled, Math.max(heartbeatSeconds, 5));
}

/** «Sin conexión. Reintentando…» no sale por un envío perdido, sino a los dos seguidos (PA-22). */
export const isOffline = (failures: number): boolean => failures >= 2;
