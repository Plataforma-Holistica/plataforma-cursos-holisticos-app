// El armado de los tramos vistos, en el navegador (RF-401, T-205). Reglas puras: la pantalla de
// la lección le pasa cada muestra del reproductor mientras el video avanza, y le dice cuándo
// cortar (cada latido, al ocultar la pestaña, al irse la página) y cuándo detenerse (pausa,
// final, búsqueda, un atasco, un error, la dirección que caduca). El reloj entra como argumento.
//
// Lo que decide dinero es no acreditar nunca un segundo que no se reprodujo; perder un poco es
// el precio. Por eso:
//   · un hueco entre dos muestras de más de `gapSeconds` de reloj no se puentea: se cierra en la
//     última muestra y se abre en la siguiente. Una muestra tardía después de una pausa, seguida
//     de otra diez minutos después en otro lugar, no acredita lo de en medio;
//   · un salto que no cabe en el reloj (más de lo que avanzó por la velocidad, más medio
//     segundo) o que retrocede más de medio segundo es una búsqueda, y también corta;
//   · el inicio de una cadena va hacia arriba y el final hacia abajo; un corte comparte con el
//     tramo siguiente un borde entero, así que dos tramos de la misma cadena no se traslapan.
//
// La base vuelve a revisar cada tramo contra el reloj de su reproducción: lo de aquí es lo que
// el navegador de la Plataforma manda de buena fe, no una barrera.

import { HEARTBEAT_LIMITS } from "./heartbeat";

/** Lo que dice el reproductor mientras el video avanza. */
export interface WatchSample {
  /** El segundo del video, con decimales. */
  at: number;
  /** Un reloj monótono, en segundos (no la hora): la pantalla pasa `performance.now() / 1000`. */
  clock: number;
  rate: number;
  /** Si la pestaña está a la vista. */
  visible: boolean;
  /** La duración que conoce el reproductor; nula o sin sentido, no recorta. */
  duration: number | null;
}

/** Un tramo cerrado: segundos enteros del video, del inicio al final sin incluirlo, y el final mayor. */
export interface Segment {
  from: number;
  to: number;
  rate: number;
  visible: boolean;
}

interface Open {
  /** Donde empieza: con decimales al empezar una cadena, entero después de un corte. */
  from: number;
  /** Si el inicio es el borde entero de un corte (no se redondea otra vez). */
  continued: boolean;
  to: number;
  rate: number;
  visible: boolean;
}

export interface SegmentBuilder {
  /** La duración de la lección que dio la concesión, que es la que revisa la base. */
  readonly granted: number | null;
  readonly open: Open | null;
  readonly last: { at: number; clock: number; duration: number | null } | null;
}

export const SEGMENT_RULES = {
  /** Más reloj que esto entre dos muestras es un hueco, y no se puentea. */
  gapSeconds: 1.5,
  /** Lo que el video puede adelantarse al reloj (por su velocidad) en una muestra. */
  aheadSeconds: 0.5,
  /** Lo que puede retroceder sin que sea una búsqueda. */
  backSeconds: 0.5,
} as const;

interface Step {
  builder: SegmentBuilder;
  closed: Segment[];
}

const usable = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

/** Un armador vacío para una reproducción, con la duración de su concesión. */
export function startSegments(granted: number | null): SegmentBuilder {
  return { granted: usable(granted) ? granted : null, open: null, last: null };
}

/** El tramo abierto, redondeado y recortado; nulo si no llega a un segundo entero. */
function close(builder: SegmentBuilder, open: Open): Segment | null {
  const limits = [builder.granted, builder.last?.duration ?? null].filter(usable);
  const end = Math.min(open.to, ...limits);
  const from = open.continued ? open.from : Math.ceil(open.from);
  const to = Math.floor(end);
  if (to <= from) return null;
  const rate = Math.min(Math.max(Math.round(open.rate * 100) / 100, HEARTBEAT_LIMITS.minRate), HEARTBEAT_LIMITS.rate);
  return { from, to, rate, visible: open.visible };
}

const fresh = (sample: WatchSample): Open => ({ from: sample.at, continued: false, to: sample.at, rate: sample.rate, visible: sample.visible });

/** Una muestra más, mientras el video avanza. */
export function observeWatch(builder: SegmentBuilder, sample: WatchSample): Step {
  const { open, last } = builder;
  const next = { at: sample.at, clock: sample.clock, duration: sample.duration };
  if (open === null || last === null) return { builder: { ...builder, open: fresh(sample), last: next }, closed: [] };
  const gap = sample.clock - last.clock;
  const moved = sample.at - last.at;
  const allowed = gap * Math.max(open.rate, sample.rate) + SEGMENT_RULES.aheadSeconds;
  if (gap < 0 || gap > SEGMENT_RULES.gapSeconds || moved > allowed || moved < -SEGMENT_RULES.backSeconds) {
    const segment = close(builder, open);
    return { builder: { ...builder, open: fresh(sample), last: next }, closed: segment === null ? [] : [segment] };
  }
  const extended: Open = { ...open, to: Math.max(open.to, sample.at) };
  if (sample.rate === open.rate && sample.visible === open.visible) return { builder: { ...builder, open: extended, last: next }, closed: [] };
  // Cambió la velocidad o la visibilidad: hasta aquí con lo de antes, y sigue desde el borde. Si
  // lo de antes no llega a un segundo entero, sigue abierto con lo nuevo: no se pierde.
  const segment = close({ ...builder, last: next }, extended);
  const attributes = { rate: sample.rate, visible: sample.visible };
  const reopened: Open = segment === null ? { ...extended, ...attributes } : { from: segment.to, continued: true, to: extended.to, ...attributes };
  return { builder: { ...builder, open: reopened, last: next }, closed: segment === null ? [] : [segment] };
}

/** Corta el tramo abierto y sigue desde su borde: cada latido, al ocultar, al irse la página. */
export function cutSegment(builder: SegmentBuilder): Step {
  const { open } = builder;
  if (open === null) return { builder, closed: [] };
  const segment = close(builder, open);
  if (segment === null) return { builder, closed: [] };
  return { builder: { ...builder, open: { ...open, from: segment.to, continued: true } }, closed: [segment] };
}

/** Cierra el tramo abierto y no sigue: la siguiente muestra empieza otra cadena. */
export function stopSegment(builder: SegmentBuilder): Step {
  const segment = builder.open === null ? null : close(builder, builder.open);
  return { builder: { ...builder, open: null }, closed: segment === null ? [] : [segment] };
}
