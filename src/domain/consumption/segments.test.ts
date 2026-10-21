import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { HEARTBEAT_LIMITS, parseHeartbeatBatch } from "./heartbeat";
import { cutSegment, observeWatch, SEGMENT_RULES, startSegments, stopSegment, type Segment, type SegmentBuilder, type WatchSample } from "./segments";

// El armado de los tramos vistos en el navegador (RF-401, T-205). Lo que importa, porque decide
// dinero: nunca acreditar un segundo que no se reprodujo, y perder lo menos posible de lo que sí.
// La base vuelve a revisar cada tramo contra el reloj de su reproducción; aquí se prueba que el
// navegador de la Plataforma, de buena fe, no mande de más.

const sample = (at: number, clock: number, more: Partial<WatchSample> = {}): WatchSample => ({ at, clock, rate: 1, visible: true, duration: null, ...more });

/** Pasa las muestras en orden y junta lo que se cerró. */
function run(builder: SegmentBuilder, samples: WatchSample[]): { builder: SegmentBuilder; closed: Segment[] } {
  const closed: Segment[] = [];
  let current = builder;
  for (const each of samples) {
    const step = observeWatch(current, each);
    closed.push(...step.closed);
    current = step.builder;
  }
  return { builder: current, closed };
}

/** Muestras cada cuarto de segundo, de `from` a `to` del video, desde el reloj `clock`. */
function playing(from: number, to: number, clock: number, more: Partial<WatchSample> = {}): WatchSample[] {
  const rate = more.rate ?? 1;
  const steps = Math.round((to - from) / (0.25 * rate));
  return Array.from({ length: steps + 1 }, (_, index) => sample(from + index * 0.25 * rate, clock + index * 0.25, more));
}

describe("un tramo seguido", () => {
  it("de 0 a 30 a velocidad normal, cortado por el latido, es [0, 30)", () => {
    const { builder } = run(startSegments(null), playing(0, 30, 100));
    const cut = cutSegment(builder);
    expect(cut.closed).toEqual([{ from: 0, to: 30, rate: 1, visible: true }]);
  });

  it("después de cortar sigue desde el mismo borde: dos tramos seguidos no se traslapan ni dejan hueco", () => {
    const first = run(startSegments(null), playing(0, 30.6, 0));
    const cut = cutSegment(first.builder);
    expect(cut.closed).toEqual([{ from: 0, to: 30, rate: 1, visible: true }]);
    const second = run(cut.builder, playing(30.6, 59.9, 30.6).slice(1));
    expect(stopSegment(second.builder).closed).toEqual([{ from: 30, to: 59, rate: 1, visible: true }]);
  });

  it("el inicio de una cadena va hacia arriba y el final hacia abajo: nunca suma de más", () => {
    const { builder } = run(startSegments(null), playing(10.25, 20.75, 0));
    expect(stopSegment(builder).closed).toEqual([{ from: 11, to: 20, rate: 1, visible: true }]);
  });

  it("menos de un segundo entero no sale; cortar no lo pierde, se queda abierto", () => {
    const { builder } = run(startSegments(null), playing(4.5, 5.5, 0));
    const cut = cutSegment(builder);
    expect(cut.closed).toEqual([]);
    const later = run(cut.builder, playing(5.5, 8, 1).slice(1));
    expect(stopSegment(later.builder).closed).toEqual([{ from: 5, to: 8, rate: 1, visible: true }]);
  });

  it("detener sin nada abierto, o cortar sin nada abierto, no saca nada", () => {
    expect(stopSegment(startSegments(null)).closed).toEqual([]);
    expect(cutSegment(startSegments(null)).closed).toEqual([]);
  });

  it("después de detener, la siguiente muestra empieza otra cadena", () => {
    const first = run(startSegments(null), playing(0, 10, 0));
    const stopped = stopSegment(first.builder);
    expect(stopped.closed).toEqual([{ from: 0, to: 10, rate: 1, visible: true }]);
    const second = run(stopped.builder, playing(10.5, 20, 600));
    expect(stopSegment(second.builder).closed).toEqual([{ from: 11, to: 20, rate: 1, visible: true }]);
  });
});

describe("lo que corta un tramo", () => {
  // No se sabe en qué momento entre dos muestras cambió: lo de en medio no se le da a ninguno, y
  // lo nuevo empieza otra cadena, hacia arriba. Se pierde menos de un segundo por cambio.
  it("cambiar la velocidad: hasta la última muestra con la de antes, y otra cadena con la nueva", () => {
    const slow = run(startSegments(null), playing(0, 10, 0));
    const fast = run(slow.builder, playing(10, 30, 10, { rate: 2 }).slice(1));
    expect(fast.closed).toEqual([{ from: 0, to: 10, rate: 1, visible: true }]);
    expect(stopSegment(fast.builder).closed).toEqual([{ from: 11, to: 30, rate: 2, visible: true }]);
  });

  it("ocultar la pestaña: lo de después sale como no visible", () => {
    const shown = run(startSegments(null), playing(0, 10, 0));
    const hidden = run(shown.builder, playing(10, 20, 10, { visible: false }).slice(1));
    expect(hidden.closed).toEqual([{ from: 0, to: 10, rate: 1, visible: true }]);
    expect(stopSegment(hidden.builder).closed).toEqual([{ from: 11, to: 20, rate: 1, visible: false }]);
  });

  it("al volver a la pestaña, nada de lo oculto se acredita como visible, aunque lo oculto no llegue a un segundo", () => {
    // Una cadena oculta que ya se cortó en 10 y lleva hasta 10.95; vuelve a la vista en 11.2.
    const hidden = run(startSegments(null), playing(0, 10, 0, { visible: false }));
    const cut = cutSegment(hidden.builder);
    const shown = run(cut.builder, [sample(10.25, 10.25, { visible: false }), sample(10.95, 10.95, { visible: false }), ...playing(11.2, 14.2, 11.2)]);
    const all = [...cut.closed, ...shown.closed, ...stopSegment(shown.builder).closed];
    expect(all).toEqual([
      { from: 0, to: 10, rate: 1, visible: false },
      { from: 12, to: 14, rate: 1, visible: true },
    ]);
  });

  it("un salto hacia adelante que no cabe en el reloj es una búsqueda: no se acredita lo saltado", () => {
    const before = run(startSegments(null), playing(0, 10, 0));
    const jumped = run(before.builder, playing(100, 110, 10.25));
    expect(jumped.closed).toEqual([{ from: 0, to: 10, rate: 1, visible: true }]);
    expect(stopSegment(jumped.builder).closed).toEqual([{ from: 100, to: 110, rate: 1, visible: true }]);
  });

  it("hasta medio segundo de más por muestra cabe (el reloj y el video no avanzan parejos)", () => {
    const { builder, closed } = run(startSegments(null), [sample(0, 0), sample(0.75, 0.25), sample(1.5, 1), sample(2.2, 1.25)]);
    expect(closed).toEqual([]);
    expect(stopSegment(builder).closed).toEqual([{ from: 0, to: 2, rate: 1, visible: true }]);
  });

  it("un poco más de medio segundo de más ya no cabe", () => {
    const { closed } = run(startSegments(null), [sample(0, 0), sample(1, 1), sample(2, 2), sample(3.51, 3)]);
    expect(closed).toEqual([{ from: 0, to: 2, rate: 1, visible: true }]);
  });

  it("hacia atrás más de medio segundo es una búsqueda; menos, ruido que no resta", () => {
    const noise = run(startSegments(null), [...playing(0, 5, 0), sample(4.6, 5.25), sample(6, 6.5)]);
    expect(noise.closed).toEqual([]);
    expect(stopSegment(noise.builder).closed).toEqual([{ from: 0, to: 6, rate: 1, visible: true }]);
    // Si se detiene justo después del ruido, lo visto hasta antes sigue contado.
    const settled = run(startSegments(null), [...playing(0, 5, 0), sample(4.6, 5.25)]);
    expect(stopSegment(settled.builder).closed).toEqual([{ from: 0, to: 5, rate: 1, visible: true }]);
    const back = run(startSegments(null), [...playing(0, 5, 0), sample(4.4, 5.25), sample(6, 6.75)]);
    expect(back.closed).toEqual([{ from: 0, to: 5, rate: 1, visible: true }]);
    expect(stopSegment(back.builder).closed).toEqual([{ from: 5, to: 6, rate: 1, visible: true }]);
  });

  it("nunca se puentea un hueco del reloj: buscar en pausa y reanudar diez minutos después no acredita nada", () => {
    // Una muestra que llegó tarde, con el video ya en pausa, y la siguiente diez minutos después.
    const stale = run(startSegments(null), [sample(100, 0), sample(400, 600), sample(401, 601)]);
    expect(stale.closed).toEqual([]);
    expect(stopSegment(stale.builder).closed).toEqual([{ from: 400, to: 401, rate: 1, visible: true }]);
  });

  it("un hueco de más de 1.5 s cierra en la última muestra, aunque el video haya avanzado lo mismo que el reloj", () => {
    expect(SEGMENT_RULES.gapSeconds).toBe(1.5);
    const { closed, builder } = run(startSegments(null), [...playing(0, 3, 0), sample(4.6, 4.6), sample(5, 5)]);
    expect(closed).toEqual([{ from: 0, to: 3, rate: 1, visible: true }]);
    // Lo de después del hueco, de 4.6 a 5, no llega a un segundo entero.
    expect(stopSegment(builder).closed).toEqual([]);
    const fine = run(startSegments(null), [...playing(0, 3, 0), sample(4.5, 4.5)]);
    expect(fine.closed).toEqual([]);
  });

  it("un reloj que retrocede tampoco se puentea, aunque el video casi no se haya movido", () => {
    const { closed } = run(startSegments(null), [...playing(0, 5, 10), sample(6, 14)]);
    expect(closed).toEqual([{ from: 0, to: 5, rate: 1, visible: true }]);
    const still = run(startSegments(null), [...playing(0, 5, 10), sample(5, 14.75)]);
    expect(still.closed).toEqual([{ from: 0, to: 5, rate: 1, visible: true }]);
  });


});

describe("la duración", () => {
  it("se recorta a la que da la concesión, que es la que revisa la base", () => {
    const { builder } = run(startSegments(356), playing(340, 360, 0));
    expect(stopSegment(builder).closed).toEqual([{ from: 340, to: 356, rate: 1, visible: true }]);
  });

  it("y a la del reproductor, si es menor", () => {
    const { builder } = run(startSegments(356), playing(340, 360, 0, { duration: 350.5 }));
    expect(stopSegment(builder).closed).toEqual([{ from: 340, to: 350, rate: 1, visible: true }]);
  });

  it("una duración del reproductor que no sirve no recorta", () => {
    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3, null]) {
      const { builder } = run(startSegments(null), playing(340, 360, 0, { duration }));
      expect(stopSegment(builder).closed, String(duration)).toEqual([{ from: 340, to: 360, rate: 1, visible: true }]);
    }
  });

  it("lo que empieza en el final o después no sale", () => {
    const { builder } = run(startSegments(356), playing(355.5, 360, 0));
    expect(stopSegment(builder).closed).toEqual([]);
  });

  it("una duración de la concesión que no sirve tampoco recorta", () => {
    const { builder } = run(startSegments(Number.NaN), playing(0, 5, 0));
    expect(stopSegment(builder).closed).toEqual([{ from: 0, to: 5, rate: 1, visible: true }]);
  });
});

describe("la velocidad que sale", () => {
  it("con dos decimales, y dentro de lo que la base acepta", () => {
    const at = (rate: number) => {
      const { builder } = run(startSegments(null), playing(0, 3, 0, { rate }));
      return stopSegment(builder).closed[0]?.rate;
    };
    expect(at(1.256)).toBe(1.26);
    expect(at(1.5)).toBe(1.5);
    expect(at(16)).toBe(HEARTBEAT_LIMITS.rate);
    expect(at(0.001)).toBe(HEARTBEAT_LIMITS.minRate);
  });
});

// Un simulador de reproducción de buena fe: guiones al azar de reproducir, pausar, buscar en
// pausa o avanzando, atascarse, cambiar la velocidad y ocultar la pestaña, con las muestras que
// mandaría la pantalla (solo mientras avanza; buscar, pausar y atascarse detienen el tramo).
type Step =
  | { kind: "play"; seconds: number; tick: number }
  | { kind: "pause"; seconds: number }
  | { kind: "seek"; to: number }
  | { kind: "stall"; seconds: number }
  | { kind: "rate"; rate: number }
  | { kind: "visibility" }
  | { kind: "cut" };

// En décimas y centésimas de segundo: `fc.double` se va casi siempre a los extremos (0, valores
// diminutos), y así los guiones casi no reproducirían nada.
const tenths = (max: number) => fc.integer({ min: 0, max: max * 10 }).map((value) => value / 10);
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("play" as const), seconds: tenths(90), tick: fc.integer({ min: 5, max: 30 }).map((value) => value / 100) }),
  fc.record({ kind: fc.constant("pause" as const), seconds: tenths(900) }),
  fc.record({ kind: fc.constant("seek" as const), to: tenths(400) }),
  fc.record({ kind: fc.constant("stall" as const), seconds: tenths(20) }),
  fc.record({ kind: fc.constant("rate" as const), rate: fc.constantFrom(0.5, 0.75, 1, 1.25, 1.5, 1.75, 2) }),
  fc.record({ kind: fc.constant("visibility" as const) }),
  fc.record({ kind: fc.constant("cut" as const) }),
);


/** Un trecho que se reprodujo de verdad, seguido y con la misma velocidad y visibilidad. */
interface Run {
  from: number;
  to: number;
  rate: number;
  visible: boolean;
}

/** Corre un guion: los trechos que se reprodujeron de verdad y lo que salió. */
function simulate(steps: Step[], duration: number) {
  let builder = startSegments(duration);
  const closed: Segment[] = [];
  const runs: Run[] = [];
  let at = 0;
  let clock = 0;
  let rate = 1;
  let visible = true;
  let current: Run | null = null;
  const take = (result: { builder: SegmentBuilder; closed: Segment[] }) => {
    builder = result.builder;
    closed.push(...result.closed);
  };
  const halt = () => {
    take(stopSegment(builder));
    current = null;
  };
  for (const each of steps) {
    switch (each.kind) {
      case "play": {
        if (current === null) {
          current = { from: at, to: at, rate, visible };
          runs.push(current);
        }
        let left = each.seconds;
        // Al empezar a avanzar, una muestra en el punto de partida. Si ya venía avanzando (cambió la
        // velocidad o la visibilidad sin pausa), la primera muestra con lo nuevo llega después de
        // moverse, como en un navegador: no se sabe en qué momento de en medio cambió.
        if (builder.open === null) take(observeWatch(builder, { at, clock, rate, visible, duration }));
        while (left > 0 && at < duration) {
          const dt = Math.min(each.tick, left);
          left -= dt;
          clock += dt;
          at = Math.min(at + dt * rate, duration);
          current.to = at;
          take(observeWatch(builder, { at, clock, rate, visible, duration }));
        }
        break;
      }
      case "pause":
      case "stall":
        halt();
        clock += each.seconds;
        break;
      case "seek":
        halt();
        at = Math.min(each.to, duration);
        break;
      // Cambiar la velocidad o la visibilidad no detiene el video, pero empieza otro trecho. Como
      // en la pantalla: la velocidad llega como una muestra (`ratechange`), y ocultar detiene la
      // cadena (`visibilitychange`); volver a la vista llega con la siguiente muestra.
      case "rate":
        if (each.rate !== rate) current = null;
        rate = each.rate;
        if (builder.open !== null) take(observeWatch(builder, { at, clock, rate, visible, duration }));
        break;
      case "visibility":
        current = null;
        visible = !visible;
        if (!visible) take(stopSegment(builder));
        break;
      case "cut":
        take(cutSegment(builder));
        break;
    }
  }
  halt();
  return { closed, runs };
}

/** Los tramos que caben en ese trecho. */
const inside = (closed: Segment[], each: Run) => closed.filter((segment) => each.from <= segment.from && segment.to <= each.to + 1e-9);

describe("propiedades, con guiones de reproducción al azar", () => {
  const scripts = fc.tuple(fc.array(step, { minLength: 2, maxLength: 40, size: "max" }), fc.integer({ min: 30, max: 400 }));

  it("ningún tramo cubre un segundo que no se reprodujo, y lleva la velocidad y la visibilidad con que se reprodujo", () => {
    fc.assert(
      fc.property(scripts, ([steps, duration]) => {
        const { closed, runs } = simulate(steps, duration);
        for (const segment of closed) {
          const home = runs.filter((each) => each.from <= segment.from && segment.to <= each.to + 1e-9 && each.visible === segment.visible && Math.round(each.rate * 100) / 100 === segment.rate);
          expect(home.length, JSON.stringify({ segment, runs })).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("dentro de un trecho, los tramos no se traslapan ni suman más que el trecho", () => {
    fc.assert(
      fc.property(scripts, ([steps, duration]) => {
        const { closed, runs } = simulate(steps, duration);
        // Un tramo cae en un solo trecho de verdad; dos trechos solo comparten segundos si se volvió a ver.
        const mine = (each: Run) => inside(closed, each).filter((segment) => !runs.some((other) => other !== each && other.from <= segment.from && segment.to <= other.to + 1e-9));
        for (const each of runs) {
          const own = mine(each).sort((a, b) => a.from - b.from);
          for (let index = 1; index < own.length; index += 1) expect(own[index]?.from).toBeGreaterThanOrEqual(own[index - 1]?.to ?? 0);
          expect(own.reduce((sum, segment) => sum + segment.to - segment.from, 0)).toBeLessThanOrEqual(each.to - each.from + 1e-9);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("todo tramo que sale tiene la forma que la base acepta, y ninguno pasa de la duración", () => {
    fc.assert(
      fc.property(scripts, ([steps, duration]) => {
        const { closed } = simulate(steps, duration);
        const events = closed.map((segment, seq) => ({ seq, ...segment }));
        for (let index = 0; index < events.length; index += HEARTBEAT_LIMITS.batch) {
          expect(parseHeartbeatBatch(events.slice(index, index + HEARTBEAT_LIMITS.batch))).not.toBeNull();
        }
        for (const segment of closed) expect(segment.to).toBeLessThanOrEqual(duration);
      }),
      { numRuns: 500 },
    );
  });

  // El redondeo de las dos puntas, y si el trecho empezó con un cambio de velocidad o de
  // visibilidad con el video avanzando, lo que avanzó hasta la primera muestra con lo nuevo: una
  // muestra (a lo más 0.3 s en el guion) a la velocidad nueva (a lo más 2×). Lo encontró una
  // corrida del 2026-10-20: volver a la vista a 1.25× perdió 2 s de un trecho de 36.
  it("lo que se pierde de un trecho es menos de dos segundos más lo que avanza hasta la primera muestra", () => {
    fc.assert(
      fc.property(scripts, ([steps, duration]) => {
        const { closed, runs } = simulate(steps, duration);
        for (const each of runs) {
          const credited = inside(closed, each)
            .filter((segment) => segment.visible === each.visible)
            .reduce((sum, segment) => sum + segment.to - segment.from, 0);
          expect(credited).toBeGreaterThan(each.to - each.from - 2 - 0.3 * 2);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("un corte avanza el borde: dos tramos del mismo trecho no se traslapan", () => {
    const { builder } = run(startSegments(null), playing(0, 20, 0));
    const first = cutSegment(builder);
    const later = run(first.builder, playing(20.25, 30, 20.25));
    const segments = [...first.closed, ...stopSegment(later.builder).closed];
    expect(segments).toEqual([
      { from: 0, to: 20, rate: 1, visible: true },
      { from: 20, to: 30, rate: 1, visible: true },
    ]);
  });
});
