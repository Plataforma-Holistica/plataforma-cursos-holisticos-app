// Los latidos que miden (RF-401 a RF-403; TRD §5.3; 05 §9.2). Reglas puras: el servicio de
// medios las pregunta antes de pasarle un lote a la base.
//
// El reproductor manda tramos vistos, cada uno con un consecutivo dentro de su reproducción:
// `[from, to)` en segundos enteros del video, la velocidad y si la pestaña estaba a la vista. No
// manda la lección ni la hora: las dos salen de la reproducción, en la base. Aquí se revisa
// solo la forma. Que el tramo quepa en la lección y en el reloj de la reproducción lo decide
// la base, que es la única que ve lo acumulado al día, bajo el candado de la cuenta, y que
// vuelve a revisar la forma: un lote que llegue sin pasar por aquí no entra por eso.
//
// Si lo visto cuenta para el reparto lo decide la regla del acceso a la hora del tramo (RN-08):
// si el acceso terminó a media lección, lo visto se guarda sin puntos (decisión de Sergio del
// 2026-10-15), y lo mismo si la lección se retiró (decisión del 2026-10-19). «No se supo» no es
// «no cuenta»: un lote guardado en falso ya no se corrige con un reintento, porque sale repetido.

import type { MediaAccess } from "../access/media-access";

/** Un tramo visto, como lo arma el reproductor. */
export interface HeartbeatEvent {
  /** El consecutivo dentro de la reproducción, desde 0. */
  seq: number;
  /** Segundo del video donde empieza, entero. */
  from: number;
  /** Segundo donde termina, sin incluirlo: siempre mayor que `from`. */
  to: number;
  rate: number;
  visible: boolean;
}

/** Los mismos límites que revisa la base. */
export const HEARTBEAT_LIMITS = {
  /** Tramos por lote: el navegador parte su cola en trozos de este tamaño. */
  batch: 50,
  seq: 1_000_000,
  /** El segundo más alto que se acepta como forma; la duración de la lección acota después. */
  second: 9_999_999,
  /** La base guarda la velocidad con dos decimales: menos de 0.01 sería 0. */
  minRate: 0.01,
  rate: 9.99,
} as const;

const FIELDS = ["seq", "from", "to", "rate", "visible"] as const;

const whole = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;

function parseEvent(value: unknown): HeartbeatEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) return null;
  const { seq, from, to, rate, visible } = value as Record<(typeof FIELDS)[number], unknown>;
  if (!whole(seq, HEARTBEAT_LIMITS.seq) || !whole(from, HEARTBEAT_LIMITS.second) || !whole(to, HEARTBEAT_LIMITS.second)) return null;
  if (to <= from) return null;
  if (typeof rate !== "number" || !(rate >= HEARTBEAT_LIMITS.minRate) || rate > HEARTBEAT_LIMITS.rate) return null;
  if (typeof visible !== "boolean") return null;
  return { seq, from, to, rate, visible };
}

/**
 * El lote, si todo él tiene la forma; si no, nulo, y no se registra nada de él. El reproductor
 * de la Plataforma nunca arma uno así: lo que no tiene forma lo mandó otra cosa.
 */
export function parseHeartbeatBatch(value: unknown): HeartbeatEvent[] | null {
  if (!Array.isArray(value) || value.length > HEARTBEAT_LIMITS.batch) return null;
  const events: HeartbeatEvent[] = [];
  for (const each of value) {
    const event = parseEvent(each);
    if (event === null) return null;
    events.push(event);
  }
  return events;
}

/** Si lo visto cuenta para el reparto: sí, no, o no se supo (y entonces no se registra). */
export type AccessCount = "counts" | "no" | "unknown";

/**
 * Lo que la regla de los medios contestó a la hora del tramo, para un lote. La base solo puede
 * bajarlo: un tramo que no sirve (oculto, más rápido que `VELOCIDAD_MAX`) o una reproducción que
 * no cuenta no cuentan aunque aquí diga que sí.
 */
export function accessCounts(access: MediaAccess): AccessCount {
  if (access.ok) return access.countsForPayout ? "counts" : "no";
  switch (access.reason) {
    case "no_access":
    case "no_video":
    case "suspended":
      return "no";
    case "unknown":
    case "refused":
      return "unknown";
  }
}
