import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { MediaAccess } from "../access/media-access";
import { accessCounts, HEARTBEAT_LIMITS, parseHeartbeatBatch, type HeartbeatEvent } from "./heartbeat";

// El lote de tramos que manda el reproductor (RF-401) y si lo visto cuenta según el acceso de
// la cuenta a la hora del tramo (RF-403). La base vuelve a revisar cada tramo y es la única que
// lo compara contra el reloj: aquí no se prueba eso.

const EVENT: HeartbeatEvent = { seq: 0, from: 0, to: 30, rate: 1, visible: true };

describe("la forma del lote", () => {
  it("un lote bien hecho sale igual, en el mismo orden", () => {
    const batch = [EVENT, { seq: 1, from: 30, to: 45, rate: 1.25, visible: false }];
    expect(parseHeartbeatBatch(batch)).toEqual(batch);
  });

  it("vacío es un lote vacío", () => {
    expect(parseHeartbeatBatch([])).toEqual([]);
  });

  it("lo que no es una lista no es un lote", () => {
    for (const value of [undefined, null, "[]", 3, { 0: EVENT, length: 1 }]) expect(parseHeartbeatBatch(value), String(value)).toBeNull();
  });

  it("a lo más 50 tramos: uno más y no es un lote", () => {
    expect(HEARTBEAT_LIMITS.batch).toBe(50);
    const many = Array.from({ length: 51 }, (_, seq) => ({ ...EVENT, seq }));
    expect(parseHeartbeatBatch(many.slice(0, 50))).toHaveLength(50);
    expect(parseHeartbeatBatch(many)).toBeNull();
  });

  it("un consecutivo repetido pasa: la base se queda con el primero", () => {
    expect(parseHeartbeatBatch([EVENT, { ...EVENT, to: 31 }])).toHaveLength(2);
  });

  it("los límites de cada campo, de un lado y del otro", () => {
    const ok = (event: Partial<HeartbeatEvent>) => parseHeartbeatBatch([{ ...EVENT, ...event }]) !== null;
    expect(ok({ seq: 0 })).toBe(true);
    expect(ok({ seq: HEARTBEAT_LIMITS.seq })).toBe(true);
    expect(ok({ seq: HEARTBEAT_LIMITS.seq + 1 })).toBe(false);
    expect(ok({ seq: -1 })).toBe(false);
    expect(ok({ from: 0, to: 1 })).toBe(true);
    expect(ok({ from: 5, to: 5 })).toBe(false);
    expect(ok({ from: 6, to: 5 })).toBe(false);
    expect(ok({ from: -1 })).toBe(false);
    expect(ok({ from: HEARTBEAT_LIMITS.second - 1, to: HEARTBEAT_LIMITS.second })).toBe(true);
    expect(ok({ from: 0, to: HEARTBEAT_LIMITS.second + 1 })).toBe(false);
    expect(ok({ rate: HEARTBEAT_LIMITS.rate })).toBe(true);
    expect(ok({ rate: 9.991 })).toBe(false);
    expect(ok({ rate: HEARTBEAT_LIMITS.minRate })).toBe(true);
    expect(ok({ rate: 0.009 })).toBe(false);
    expect(ok({ rate: 0 })).toBe(false);
    expect(ok({ rate: -1 })).toBe(false);
  });

  it("lo que no es un número entero, un número o un sí o no, según el campo, no es un tramo", () => {
    const broken: unknown[] = [
      { ...EVENT, seq: 1.5 },
      { ...EVENT, seq: "0" },
      { ...EVENT, from: 0.5 },
      { ...EVENT, to: "30" },
      { ...EVENT, rate: Number.NaN },
      { ...EVENT, rate: Number.POSITIVE_INFINITY },
      { ...EVENT, rate: "1" },
      { ...EVENT, visible: "true" },
      { ...EVENT, visible: 1 },
      { seq: 0, from: 0, to: 30, rate: 1 },
      { ...EVENT, lessonId: "a" },
      null,
      [0, 0, 30, 1, true],
      "tramo",
    ];
    for (const event of broken) expect(parseHeartbeatBatch([EVENT, event]), JSON.stringify(event)).toBeNull();
  });

  it("lo que sale no trae nada que no se le pidió, aunque el objeto lo herede", () => {
    const inherited = Object.assign(Object.create({ lessonId: "a" }) as object, EVENT);
    expect(parseHeartbeatBatch([inherited])).toEqual([EVENT]);
    expect(Object.keys(parseHeartbeatBatch([inherited])?.[0] ?? {})).toEqual(["seq", "from", "to", "rate", "visible"]);
  });

  it("propiedad: todo tramo dentro de los límites pasa, y sale tal cual", () => {
    const event = fc
      .record({
        seq: fc.integer({ min: 0, max: HEARTBEAT_LIMITS.seq }),
        from: fc.integer({ min: 0, max: HEARTBEAT_LIMITS.second - 1 }),
        length: fc.integer({ min: 1, max: HEARTBEAT_LIMITS.second }),
        rate: fc.double({ min: 0.01, max: HEARTBEAT_LIMITS.rate, noNaN: true }),
        visible: fc.boolean(),
      })
      .map(({ length, ...rest }) => ({ ...rest, to: Math.min(rest.from + length, HEARTBEAT_LIMITS.second) }));
    fc.assert(
      fc.property(fc.array(event, { maxLength: HEARTBEAT_LIMITS.batch }), (batch) => {
        expect(parseHeartbeatBatch(batch)).toEqual(batch);
      }),
    );
  });

  it("propiedad: un tramo que no avanza nunca pasa", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: HEARTBEAT_LIMITS.second }), fc.integer({ min: 0, max: 100 }), (from, back) => {
        expect(parseHeartbeatBatch([{ ...EVENT, from, to: Math.max(from - back, 0) }])).toBeNull();
      }),
    );
  });
});

describe("si lo visto cuenta, según el acceso a la hora del tramo", () => {
  const LATER = new Date("2026-11-01T00:00:00.000Z");
  const cases: [string, MediaAccess, ReturnType<typeof accessCounts>][] = [
    ["suscripción", { ok: true, basis: "subscription", countsForPayout: true, until: LATER }, "counts"],
    ["gracia", { ok: true, basis: "grace", countsForPayout: true, until: LATER }, "counts"],
    ["cortesía", { ok: true, basis: "courtesy", countsForPayout: false, until: null }, "no"],
    ["curso abierto", { ok: true, basis: "open_course", countsForPayout: false, until: null }, "no"],
    ["el maestro dueño", { ok: true, basis: "owner_preview", countsForPayout: false, until: null }, "no"],
    // El fin del acceso a media lección: se guarda sin puntos (decisión de Sergio del 2026-10-15).
    ["el acceso terminó", { ok: false, reason: "no_access", account: { allowed: false, reason: "expired", endedAt: LATER } }, "no"],
    // La lección se retiró o dejó de verse: desde ahí no cuenta (decisión de Sergio del 2026-10-19).
    ["la lección ya no se ve", { ok: false, reason: "no_video" }, "no"],
    ["la cuenta se suspendió", { ok: false, reason: "suspended" }, "no"],
    // «No se supo» no es «no cuenta»: se guardaría para siempre en falso.
    ["no se supo", { ok: false, reason: "unknown" }, "unknown"],
    ["rechazado", { ok: false, reason: "refused" }, "unknown"],
  ];
  it.each(cases)("%s", (_, access, expected) => {
    expect(accessCounts(access)).toBe(expected);
  });
});
