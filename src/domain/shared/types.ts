// Tipos comunes a los cuatro módulos del dominio (TRD §5). El dinero va en centavos
// enteros y los puntos en medios puntos enteros: no hay decimales en el camino del
// dinero (RNF-04, ADR-24).

export type Id = string; // identificador opaco
export type Cents = bigint; // dinero, siempre en centavos enteros
export type Bps = number; // porcentaje en puntos base: 10 000 es el 100 %
export type HalfPoints = 0 | 1 | 2; // 0, medio punto y un punto, sin decimales
export type PeriodId = number; // año y mes, por ejemplo 202610, en ZONA_HORARIA_PERIODO

// Segundos de la lección, [from, to)
export interface Interval {
  from: number;
  to: number;
}
