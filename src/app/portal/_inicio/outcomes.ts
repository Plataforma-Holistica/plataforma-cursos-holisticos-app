// El mismo formato de pesos que las liquidaciones (PA-46, PA-47 y PA-81), y el mismo nombre de mes.
import { money } from "@/app/admin/_periodos/rows";
import { clockTime, longDate, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { portalCoursePath, portalPayoutPath, portalStudentsPath, ROUTES } from "@/services/account/navigation";
import type { DashboardFigures, DashboardValue } from "@/services/teachers/dashboard-data";
import type { PeriodBar } from "@/ui/period-bars";

import { periodTitle } from "../_pagos/rows";

// La tabla pura del panel del maestro (PA-41; T-408): qué se pinta con lo que contestó la base, ya en palabras. El componente no lee centavos ni fechas.
// No decide nada que la base no haya decidido: sin corrida buena no hay cifra (se dice «Sin datos todavía», nunca un cero), y si la última falló se dice
// de cuándo son las que se ven. Lo estimado va sin el bote sin consumo, los bonos ni los ajustes (decisión 1 de Sergio del 2026-11-04), y su aviso lo dice.
// Nunca hay nada por alumno ni el porcentaje del bote: la base no los da.

const text = portal.home;

const COUNT = new Intl.NumberFormat("es-MX");
const count = (value: number): string => COUNT.format(value);

/** Lo que el inicio supo de los datos fiscales; nulo si no se supo. */
export interface TaxDataFacts {
  version: number;
  canSave: boolean;
}

export interface FirstStep {
  key: string;
  label: string;
  /** A dónde lleva el paso; nulo si ya está hecho o no se puede hacer. */
  href: string | null;
  /** «Listo» o «Pendiente»; nulo si no se supo. */
  state: string | null;
  /** El tono de su etiqueta, como valor: la pantalla no lo deduce del texto. Nulo junto con `state`. */
  tone: "good" | "attention" | null;
}

export interface CourseRowView {
  key: string;
  title: string;
  href: string | null;
  /** El avance de sus alumnos (PA-51), con su nombre accesible; nulo si el curso ya no es suyo. */
  progress: { href: string; name: string } | null;
  fullLessons: string | null;
  halfLessons: string | null;
  students: string | null;
}

export interface DashboardView {
  /** «Para empezar», a quien nunca ha publicado: entonces no hay cifras que mostrar. */
  firstTime: FirstStep[] | null;
  /** «Marzo de 2031, en curso». */
  month: string;
  /** «Actualizado el…»; nulo sin corrida buena. */
  updated: string | null;
  /** El aviso de la corrida: falló la última, o todavía no hay ninguna. */
  runNotice: { tone: "warning" | "neutral"; text: string } | null;
  tiles: {
    estimated: { value: string | null; context: string | null };
    fullLessons: string | null;
    halfLessons: string | null;
    students: string | null;
  };
  /** Hubo corrida y nadie vio nada: los ceros sí se midieron. */
  noViews: boolean;
  courses: CourseRowView[];
  series: PeriodBar[];
}

const figure = (figures: DashboardFigures | null, key: keyof DashboardFigures): string | null => (figures === null ? null : count(figures[key]));

/** Nunca publicó nada ni tiene cifras: no hay curso suyo ni periodo que mostrar. Uno que despublicó todo sigue viendo lo suyo. */
export function isFirstTime(value: DashboardValue): boolean {
  return !value.hasPublished && value.courses.length === 0 && value.series.length === 0;
}

/**
 * «Para empezar»: los datos fiscales (PA-48) y el primer curso (PA-42). La semblanza (PA-49) todavía no existe, y no se promete. Un paso hecho no
 * enlaza; uno que no se puede hacer tampoco: un suspendido por fraude no captura datos, y un suspendido en solo lectura no crea cursos.
 */
export function firstSteps(taxData: TaxDataFacts | null, readOnly: boolean): FirstStep[] {
  const taxDone = taxData !== null && taxData.version > 0;
  return [
    {
      key: "datos-fiscales",
      label: text.firstTime.taxData,
      href: taxDone || taxData?.canSave === false ? null : ROUTES.portalTaxData,
      state: taxData === null ? null : taxDone ? text.firstTime.done : text.firstTime.pending,
      tone: taxData === null ? null : taxDone ? "good" : "attention",
    },
    { key: "primer-curso", label: text.firstTime.course, href: readOnly ? null : ROUTES.portalCourses, state: text.firstTime.pending, tone: "attention" },
  ];
}

function runNotice(value: DashboardValue): DashboardView["runNotice"] {
  const { run, lastFailed, stale } = value.current;
  // Una corrida buena vieja (la noche no la renovó) se dice igual que una fallida: lo que se ve es de antes.
  if (lastFailed || (stale && run !== null)) return { tone: "warning", text: run === null ? text.lastFailedNoRun : t(text.lastFailed, { date: longDate(run.updatedAt) }) };
  return run === null ? { tone: "neutral", text: text.noRun } : null;
}

/** La serie: los cerrados con su total y enlazados a su liquidación; los que todavía no cierran, como estimado y sin enlace. */
function seriesBars(value: DashboardValue): PeriodBar[] {
  return value.series.map((each) => {
    const cents = each.estimated ? each.cents : (each.cents ?? 0);
    const href = each.estimated ? null : portalPayoutPath(each.period);
    return {
      key: each.period,
      label: periodTitle(each.period),
      amount: cents === null ? null : money(cents),
      value: cents,
      estimated: each.estimated,
      ...(each.estimated ? { note: text.closing } : {}),
      ...(href === null ? {} : { href }),
    };
  });
}

/** @param readOnly El maestro está suspendido: ve todo, y no se le ofrece lo que no puede hacer. */
export function dashboardView(value: DashboardValue, taxData: TaxDataFacts | null, readOnly: boolean): DashboardView {
  const { run } = value.current;
  return {
    firstTime: isFirstTime(value) ? firstSteps(taxData, readOnly) : null,
    month: t(text.month, { month: periodTitle(value.current.period) }),
    updated: run === null ? null : t(text.updatedAt, { date: longDate(run.updatedAt), time: clockTime(run.updatedAt, PRODUCT_TIME_ZONE) }),
    runNotice: runNotice(value),
    tiles: {
      estimated: {
        value: run === null ? null : money(run.estimatedCents),
        context: run === null ? null : t(text.estimatedContext, { date: longDate(run.updatedAt) }),
      },
      fullLessons: figure(run, "fullLessons"),
      halfLessons: figure(run, "halfLessons"),
      students: figure(run, "students"),
    },
    noViews: run !== null && run.fullLessons === 0 && run.halfLessons === 0 && run.students === 0,
    courses: value.courses.map((course) => courseRow(course)),
    series: seriesBars(value),
  };
}

function courseRow(course: DashboardValue["courses"][number]): CourseRowView {
  const title = course.title ?? text.untitled;
  // Un curso que ya no es suyo no enlaza: su editor y el avance de sus alumnos son de otro maestro.
  const progress = course.owned ? portalStudentsPath(course.courseId) : null;
  return {
    key: course.courseId,
    title,
    href: course.owned ? portalCoursePath(course.courseId) : null,
    progress: progress === null ? null : { href: progress, name: t(text.progressLink, { title }) },
    fullLessons: figure(course.figures, "fullLessons"),
    halfLessons: figure(course.figures, "halfLessons"),
    students: figure(course.figures, "students"),
  };
}
