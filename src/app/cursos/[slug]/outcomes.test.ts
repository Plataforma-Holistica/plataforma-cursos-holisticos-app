import { describe, expect, it } from "vitest";

import type { CourseDetail, CourseStanding } from "@/services/browse/browse";
import type { LessonAccess } from "@/services/media/media";

import { primaryAction } from "./outcomes";

// El botón principal de la ficha de un curso (PA-02), caso por caso de su tabla de acciones.

const FIRST = "11111111-1111-4111-8111-111111111111";
const THIRD = "33333333-3333-4333-8333-333333333333";

const detail = (isOpen = false): CourseDetail => ({
  course: {
    slug: "respirar",
    title: "Respirar",
    summary: null,
    teacherName: "Ana",
    teacherSlug: null,
    practice: null,
    level: null,
    lessonCount: 3,
    totalSeconds: 900,
    publishedAt: new Date(0),
    isOpen,
  },
  teacher: null,
  modules: [],
  firstLesson: { id: FIRST, title: "Primera" },
});

const standing = (over: Partial<CourseStanding>): CourseStanding => ({
  states: new Map(),
  completed: 0,
  total: 3,
  started: false,
  finished: false,
  suggested: { id: FIRST, number: 1 },
  ...over,
});

const allowed: LessonAccess = { kind: "allowed" };
const lesson = (id: string) => `/cursos/respirar/lecciones/${id}`;
const signUp = (id: string) => `/registro?volver=${encodeURIComponent(lesson(id))}`;

describe("el visitante", () => {
  it("curso normal: «Suscribirme para verlo», a registrarse con la primera lección de destino", () => {
    expect(primaryAction(detail(), { kind: "visitor" })).toEqual({ kind: "subscribe", href: signUp(FIRST) });
  });

  it("curso abierto: «Verlo sin costo», también a registrarse", () => {
    expect(primaryAction(detail(true), { kind: "visitor" })).toEqual({ kind: "open_free", href: signUp(FIRST) });
  });
});

it("si no se sabe quién mira, sin botón: ni registrarse ni empezar", () => {
  expect(primaryAction(detail(), { kind: "unknown" })).toEqual({ kind: "none" });
});

describe("el alumno", () => {
  it("sin acceso: «Suscribirme para verlo», a la lección, donde PA-33 dice por qué", () => {
    const denied = { kind: "denied", account: { kind: "never" } } as unknown as LessonAccess;
    expect(primaryAction(detail(), { kind: "student", access: denied, standing: standing({}) })).toEqual({ kind: "subscribe", href: lesson(FIRST) });
  });

  it("con la cuenta suspendida, sin botón", () => {
    expect(primaryAction(detail(), { kind: "student", access: { kind: "suspended" }, standing: null })).toEqual({ kind: "none" });
  });

  it("con acceso y sin empezar: «Empezar», la primera", () => {
    expect(primaryAction(detail(), { kind: "student", access: allowed, standing: standing({}) })).toEqual({ kind: "start", href: lesson(FIRST) });
  });

  it("con avance: «Continuar: lección n», la sugerida", () => {
    const viewer = { kind: "student", access: allowed, standing: standing({ started: true, completed: 2, suggested: { id: THIRD, number: 3 } }) } as const;
    expect(primaryAction(detail(), viewer)).toEqual({ kind: "continue", href: lesson(THIRD), number: 3 });
  });

  it("con el curso terminado: «Volver a ver», desde la primera", () => {
    const viewer = { kind: "student", access: allowed, standing: standing({ started: true, finished: true, completed: 3, suggested: null }) } as const;
    expect(primaryAction(detail(), viewer)).toEqual({ kind: "again", href: lesson(FIRST) });
  });

  it("si no se supo el avance, «Empezar»: la lección arranca donde se quedó de todos modos", () => {
    expect(primaryAction(detail(), { kind: "student", access: allowed, standing: null })).toEqual({ kind: "start", href: lesson(FIRST) });
  });

  it.each(["no_video", "refused", "unavailable"] as const)("si el acceso contesta %s, decide el avance: la lección lo explica", (kind) => {
    expect(primaryAction(detail(), { kind: "student", access: { kind }, standing: standing({}) })).toEqual({ kind: "start", href: lesson(FIRST) });
  });
});
