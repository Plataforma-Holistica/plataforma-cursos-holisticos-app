import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { HEARTBEAT_LIMITS, type HeartbeatEvent } from "./heartbeat";
import {
  batchOf,
  emptyQueue,
  enqueue,
  isOffline,
  parseQueue,
  QUEUE_LIFE_MS,
  queueKey,
  queueSessionOf,
  resolveBatch,
  retryDelaySeconds,
  settle,
  type WatchQueue,
} from "./queue";
import type { Segment } from "./segments";

// La cola de tramos de una reproducción, como la guarda el navegador (RF-401, RNF-05; T-205): qué
// se guarda, qué se lee de vuelta, qué sale en cada envío y qué se quita con cada respuesta.

const NOW = Date.UTC(2026, 9, 20, 12);
const SESSION = "d0000000-0000-4000-8000-000000000004";
const SEGMENT: Segment = { from: 0, to: 30, rate: 1, visible: true };
const segments = (count: number): Segment[] => Array.from({ length: count }, (_, index) => ({ ...SEGMENT, from: index * 30, to: index * 30 + 30 }));

describe("la llave", () => {
  it("lleva el prefijo y la reproducción, y de vuelta da la reproducción", () => {
    expect(queueKey(SESSION)).toBe(`plataforma-latidos:${SESSION}`);
    expect(queueSessionOf(queueKey(SESSION))).toBe(SESSION);
  });

  it("lo que no es del prefijo o no es un identificador no es de la cola", () => {
    for (const key of ["", SESSION, `otra:${SESSION}`, "plataforma-latidos:", "plataforma-latidos:abc", `plataforma-latidos:${SESSION.toUpperCase()}`, `plataforma-latidos:${SESSION}x`, `plataforma-latidos:x${SESSION}`]) {
      expect(queueSessionOf(key), key).toBeNull();
    }
  });
});

describe("encolar", () => {
  it("pone consecutivos desde 0, en orden, y anota cuándo", () => {
    const queue = enqueue(emptyQueue(NOW - 5), segments(3), NOW);
    expect(queue).toEqual({
      v: 1,
      touched: NOW,
      next: 3,
      events: [
        { seq: 0, from: 0, to: 30, rate: 1, visible: true },
        { seq: 1, from: 30, to: 60, rate: 1, visible: true },
        { seq: 2, from: 60, to: 90, rate: 1, visible: true },
      ],
    });
    expect(enqueue(queue, segments(1), NOW + 1).events.at(-1)?.seq).toBe(3);
  });

  it("nada que encolar no cambia nada", () => {
    const queue = enqueue(emptyQueue(NOW), segments(2), NOW);
    expect(enqueue(queue, [], NOW + 10)).toBe(queue);
  });

  it("pasado el tope de consecutivos ya no agrega: la base no lo aceptaría", () => {
    const full: WatchQueue = { v: 1, touched: NOW, next: HEARTBEAT_LIMITS.seq, events: [] };
    const once = enqueue(full, segments(3), NOW);
    expect(once.events.map((event) => event.seq)).toEqual([HEARTBEAT_LIMITS.seq]);
    expect(once.next).toBe(HEARTBEAT_LIMITS.seq + 1);
    expect(enqueue(once, segments(1), NOW)).toBe(once);
  });

  it("un tramo sin la forma que acepta la base no entra: tiraría el lote entero", () => {
    const queue = enqueue(emptyQueue(NOW), [{ ...SEGMENT, to: 0 }, { ...SEGMENT, rate: 0 }, SEGMENT], NOW);
    expect(queue.events).toEqual([{ seq: 0, ...SEGMENT }]);
  });
});

describe("lo que sale en un envío", () => {
  it("los primeros 50 que no van ya en camino", () => {
    const queue = enqueue(emptyQueue(NOW), segments(60), NOW);
    expect(batchOf(queue, new Set()).map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, seq) => seq));
    expect(batchOf(queue, new Set([0, 1, 2])).map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 3));
    expect(batchOf(emptyQueue(NOW), new Set())).toEqual([]);
  });
});

describe("la respuesta del lote", () => {
  const queue = enqueue(emptyQueue(NOW), segments(5), NOW);
  const sent = queue.events.slice(0, 3);

  it("resuelto: se quitan los consecutivos que la base resolvió, solo de los enviados", () => {
    const after = resolveBatch(queue, sent, { kind: "settled", seqs: [0, 2, 4] }, NOW + 1);
    expect(after.events.map((event) => event.seq)).toEqual([1, 3, 4]);
    expect(after.touched).toBe(NOW + 1);
    expect(after.next).toBe(5);
  });

  it("tirar: se va todo lo enviado, nada más", () => {
    expect(resolveBatch(queue, sent, { kind: "discard" }, NOW + 1).events.map((event) => event.seq)).toEqual([3, 4]);
  });

  it("reintentar, o sin respuesta: se queda todo", () => {
    expect(resolveBatch(queue, sent, { kind: "retry" }, NOW + 1)).toBe(queue);
    expect(resolveBatch(queue, sent, null, NOW + 1)).toBe(queue);
  });

  it("quitar lo que ya no está no cambia nada", () => {
    expect(settle(queue, [9], NOW + 1)).toBe(queue);
    expect(settle(queue, [], NOW + 1)).toBe(queue);
  });
});

describe("leer lo guardado", () => {
  const queue = enqueue(emptyQueue(NOW), segments(3), NOW);

  it("ida y vuelta", () => {
    expect(parseQueue(JSON.stringify(queue), NOW)).toEqual(queue);
    expect(parseQueue(JSON.stringify(emptyQueue(NOW)), NOW)).toEqual(emptyQueue(NOW));
  });

  it("vencida a los siete días sin escribirse", () => {
    expect(QUEUE_LIFE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseQueue(JSON.stringify(queue), NOW + QUEUE_LIFE_MS)).toEqual(queue);
    expect(parseQueue(JSON.stringify(queue), NOW + QUEUE_LIFE_MS + 1)).toBeNull();
  });

  it("lo que no tiene la forma exacta no es una cola", () => {
    const broken: unknown[] = [
      null,
      "texto",
      [],
      { ...queue, v: 2 },
      { ...queue, touched: "ayer" },
      { ...queue, touched: Number.NaN },
      { ...queue, next: -1 },
      { ...queue, next: 1.5 },
      { ...queue, next: HEARTBEAT_LIMITS.seq + 2 },
      { ...queue, next: 2 },
      { ...queue, events: "[]" },
      { ...queue, events: [...queue.events, { ...queue.events[0], seq: 1 }] },
      { ...queue, events: [{ ...queue.events[0], to: 0 }] },
      { ...queue, events: [{ ...queue.events[0], extra: 1 }] },
      { ...queue, extra: true },
      { v: 1, touched: NOW, next: 0 },
    ];
    for (const value of broken) expect(parseQueue(JSON.stringify(value), NOW), JSON.stringify(value)).toBeNull();
    expect(parseQueue(null, NOW)).toBeNull();
    expect(parseQueue("{", NOW)).toBeNull();
  });

  it("una cola de más de 50 se lee entera: el tope es del lote, no de la cola", () => {
    const long = enqueue(emptyQueue(NOW), segments(80), NOW);
    expect(parseQueue(JSON.stringify(long), NOW)?.events).toHaveLength(80);
  });

  it("propiedad: lo que se encola y se resuelve se lee igual, con consecutivos crecientes y únicos", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.integer({ min: 0, max: 8 }), fc.array(fc.nat({ max: 40 }), { maxLength: 6 })), { maxLength: 20 }), (steps) => {
        let current = emptyQueue(NOW);
        for (const each of steps) current = typeof each === "number" ? enqueue(current, segments(each), NOW) : settle(current, each, NOW);
        const seqs = current.events.map((event: HeartbeatEvent) => event.seq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(seqs.every((seq) => seq < current.next)).toBe(true);
        expect(parseQueue(JSON.stringify(current), NOW)).toEqual(current);
      }),
    );
  });
});

describe("los reintentos y la nota «Sin conexión»", () => {
  it("la espera crece 5, 10, 20 s y se queda en el latido", () => {
    expect([1, 2, 3, 4, 9].map((failures) => retryDelaySeconds(failures, 30))).toEqual([5, 10, 20, 30, 30]);
    expect(retryDelaySeconds(0, 30)).toBe(5);
    expect(retryDelaySeconds(3, 12)).toBe(12);
    expect(retryDelaySeconds(1, 2)).toBe(5);
    expect(retryDelaySeconds(60, 30)).toBe(30);
  });

  it("la nota sale a los dos envíos fallidos seguidos, no con uno", () => {
    expect([0, 1, 2, 3].map(isOffline)).toEqual([false, false, true, true]);
  });
});
