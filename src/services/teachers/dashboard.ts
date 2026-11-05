import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { FailureCode } from "@/services/error-reporting/server";

// El panel del maestro (RF-601, RF-602, RF-612; PA-41; T-408). El maestro lee lo suyo, también suspendido: cómo va su mes, por curso, y la serie de
// sus periodos. El mes en curso sale de la última corrida buena del estimado, con su fecha, y sin ella no hay cifra: el panel no inventa una. Lo estimado
// es lo que el reparto le asignaría hoy por lo que vieron sus alumnos, sin el bote sin consumo, los bonos ni los ajustes (decisión 1 de Sergio del
// 2026-11-04). Nunca hay nada por alumno ni el porcentaje del bote. Lo decide la base; aquí se revisa la forma.

/** Las cifras de un mes, finales para el día de la corrida. */
export interface DashboardFigures {
  /** Lecciones terminadas: pares de alumno y lección con sus dos medios puntos. */
  fullLessons: number;
  /** A medias: con uno. */
  halfLessons: number;
  /** Alumnos distintos con algún medio punto. */
  students: number;
}

/** La última corrida buena del mes en curso. */
export interface DashboardRun extends DashboardFigures {
  /** Lo asignado por consumo, sin el bote sin consumo, los bonos ni los ajustes. */
  estimatedCents: number;
  /** Cuándo terminó la corrida: «Actualizado el…». */
  updatedAt: string;
}

export interface DashboardCurrent {
  /** El mes en curso, «AAAA-MM». */
  period: string;
  /** Nula si todavía no hay ninguna corrida buena del mes. */
  run: DashboardRun | null;
  /** La última corrida del mes falló: lo que se ve es de antes, o nada. */
  lastFailed: boolean;
  /** La corrida buena tiene más de 26 horas: la noche no la renovó, aunque no haya dejado una fallida. */
  stale: boolean;
}

export interface DashboardCourse {
  courseId: string;
  /** Nulo si la base no tiene título que darle. */
  title: string | null;
  /** Nulas si no hay corrida buena del mes. */
  figures: DashboardFigures | null;
}

/** Un periodo de la serie: cerrado con su total, o todavía sin cerrar (en cierre, o abierto antes del mes en curso) con lo estimado. */
export interface DashboardPeriod {
  period: string;
  /** Nulo si no hay cifra (un estimado sin corrida buena). Un cerrado sin total suyo llega en cero, como en PA-46. */
  cents: number | null;
  estimated: boolean;
}

export interface DashboardValue {
  /** Si tiene algún curso publicado ahora. */
  hasPublished: boolean;
  current: DashboardCurrent;
  courses: DashboardCourse[];
  /** Del más viejo al más nuevo, hasta 12. */
  series: DashboardPeriod[];
}

export type DashboardAnswer = { outcome: "ok"; value: DashboardValue } | { outcome: "not_teacher" };

export interface DashboardStore {
  read: (claims: VerifiedClaims) => Promise<DashboardAnswer>;
}

export interface DashboardDeps {
  store: DashboardStore;
  report: (code: FailureCode) => Promise<void>;
}

/** Lo que contestó la base, o «no se supo». */
export type DashboardRead = { kind: "ready"; value: DashboardAnswer } | { kind: "unavailable" };

export function createDashboard(deps: DashboardDeps) {
  const { store, report } = deps;

  /** PA-41, con las claims que la guarda le dio a la página. Una caída o una respuesta sin forma es «no se supo», y se reporta. */
  async function teacherDashboard(claims: VerifiedClaims): Promise<DashboardRead> {
    try {
      return { kind: "ready", value: await store.read(claims) };
    } catch {
      await report("teacher_dashboard_unavailable");
      return { kind: "unavailable" };
    }
  }

  return { teacherDashboard };
}
