import { describe, expect, it } from "vitest";

import { courseDetailOf, courseStandingOf, type CourseLessonRow, type MyLessonProgress } from "./course";
import type { ShelfCourse } from "./shelf";

const COURSE: ShelfCourse = {
  slug: "respirar",
  title: "Respirar",
  summary: "Un resumen.",
  teacherName: "Ana Robles",
  teacherSlug: "ana-robles",
  practice: null,
  level: null,
  lessonCount: 3,
  totalSeconds: 900,
  publishedAt: new Date(0),
  isOpen: false,
};
const TEACHER = { slug: "ana-robles", name: "Ana Robles", bio: null };

const row = (moduleId: string, modulePosition: number, lessonId: string, lessonPosition: number): CourseLessonRow => ({
  moduleId,
  moduleTitle: `Módulo ${moduleId}`,
  modulePosition,
  lessonId,
  lessonTitle: `Lección ${lessonId}`,
  lessonPosition,
  durationSeconds: 300,
});

// Llegan desordenadas, como puede devolverlas la base.
const ROWS = [row("m2", 2, "l3", 3), row("m1", 1, "l2", 2), row("m1", 1, "l1", 1)];

const progress = (lessonId: string, completed: boolean, minute: number): MyLessonProgress => ({
  lessonId,
  facts: { coveredSeconds: completed ? 300 : 60, position: completed ? 299 : 60, completed, sameVideo: true },
  lastWatchedAt: new Date(Date.UTC(2026, 9, 27, 10, minute)),
});

describe("courseDetailOf", () => {
  it("arma el temario por módulos, numerado en el curso entero", () => {
    const detail = courseDetailOf(COURSE, TEACHER, ROWS);
    expect(detail?.modules.map((group) => [group.id, group.lessons.map((lesson) => [lesson.id, lesson.number])])).toEqual([
      ["m1", [["l1", 1], ["l2", 2]]],
      ["m2", [["l3", 3]]],
    ]);
    expect(detail?.firstLesson).toEqual({ id: "l1", title: "Lección l1" });
  });

  it("sin lecciones vigentes no hay ficha", () => {
    expect(courseDetailOf(COURSE, TEACHER, [])).toBeNull();
  });
});

describe("courseStandingOf", () => {
  const detail = courseDetailOf(COURSE, TEACHER, ROWS);
  if (detail === null) throw new Error("la ficha de prueba no se armó");

  it("sin nada visto: sin empezar, y la sugerida es la primera", () => {
    const standing = courseStandingOf(detail, []);
    expect(standing).toMatchObject({ completed: 0, total: 3, started: false, finished: false, suggested: { id: "l1", number: 1 } });
    expect([...standing.states.values()]).toEqual(["not_started", "not_started", "not_started"]);
  });

  it("con avance: la sugerida es la última que vio si no la terminó", () => {
    const standing = courseStandingOf(detail, [progress("l1", true, 1), progress("l2", false, 5)]);
    expect(standing).toMatchObject({ completed: 1, started: true, finished: false, suggested: { id: "l2", number: 2 } });
    expect(standing.states.get("l2")).toBe("in_progress");
  });

  it("si la última que vio está terminada, la siguiente sin terminar", () => {
    const standing = courseStandingOf(detail, [progress("l2", true, 9), progress("l1", false, 1)]);
    expect(standing.suggested).toEqual({ id: "l3", number: 3 });
  });

  it("terminado: sin sugerida", () => {
    const standing = courseStandingOf(detail, [progress("l1", true, 1), progress("l2", true, 2), progress("l3", true, 3)]);
    expect(standing).toMatchObject({ completed: 3, finished: true, suggested: null });
  });

  it("lo guardado de una lección que ya no está en el temario no cuenta", () => {
    const standing = courseStandingOf(detail, [progress("retirada", true, 9)]);
    expect(standing).toMatchObject({ completed: 0, started: false, suggested: { id: "l1", number: 1 } });
  });
});
