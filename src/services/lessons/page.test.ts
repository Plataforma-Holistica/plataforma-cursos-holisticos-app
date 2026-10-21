import { describe, expect, it } from "vitest";

import { lessonPageOf, type LessonRowData } from "./page";

// La página de una lección (PA-22) armada con sus filas: el temario por módulos en su orden,
// la lección pedida y la siguiente, y desde T-206 el estado de cada fila y cuántas van.

const row = (module: number, lesson: number, overrides: Partial<LessonRowData> = {}): LessonRowData => ({
  courseSlug: "respirar",
  courseTitle: "Respirar para volver a dormir",
  courseSummary: "Un curso corto.",
  teacherName: "Ana Robles",
  moduleId: `m${module}`,
  moduleTitle: `Módulo ${module}`,
  modulePosition: module,
  lessonId: `l${lesson}`,
  lessonTitle: `Lección ${lesson}`,
  lessonPosition: lesson,
  durationSeconds: 60 * lesson,
  progress: null,
  ...overrides,
});

// Desordenadas a propósito: la base no promete el orden.
const ROWS = [row(2, 4), row(1, 2), row(2, 3), row(1, 1)];

describe("la página de una lección", () => {
  it("arma el temario por módulos, en orden, con la lección en curso marcada", () => {
    const page = lessonPageOf(ROWS, "l3");
    expect(page?.modules).toEqual([
      {
        id: "m1",
        title: "Módulo 1",
        lessons: [
          { id: "l1", title: "Lección 1", number: 1, durationSeconds: 60, current: false, state: "not_started" },
          { id: "l2", title: "Lección 2", number: 2, durationSeconds: 120, current: false, state: "not_started" },
        ],
      },
      {
        id: "m2",
        title: "Módulo 2",
        lessons: [
          { id: "l3", title: "Lección 3", number: 3, durationSeconds: 180, current: true, state: "not_started" },
          { id: "l4", title: "Lección 4", number: 4, durationSeconds: 240, current: false, state: "not_started" },
        ],
      },
    ]);
    expect(page?.lessonCount).toBe(4);
    expect(page?.progress).toEqual({ completed: 0, total: 4 });
  });

  it("trae el curso, la lección con su número y su módulo, y la siguiente", () => {
    expect(lessonPageOf(ROWS, "l2")).toMatchObject({
      course: { slug: "respirar", title: "Respirar para volver a dormir", summary: "Un curso corto.", teacherName: "Ana Robles" },
      lesson: { id: "l2", title: "Lección 2", number: 2, durationSeconds: 120, moduleTitle: "Módulo 1" },
      next: { id: "l3", title: "Lección 3" },
    });
  });

  it("la siguiente cruza de módulo, y la última no tiene", () => {
    expect(lessonPageOf(ROWS, "l2")?.next?.id).toBe("l3");
    expect(lessonPageOf(ROWS, "l4")?.next).toBeNull();
  });

  it("una lección que no está entre las filas (no existe, no está vigente o es de otro curso): nula", () => {
    expect(lessonPageOf(ROWS, "l9")).toBeNull();
    expect(lessonPageOf([], "l1")).toBeNull();
  });

  it("el orden de una lección es el del curso entero, no el de su módulo", () => {
    const rows = [row(1, 1), row(2, 1, { lessonId: "x", lessonTitle: "Otra" })];
    // Dos lecciones con la misma posición en módulos distintos: manda el módulo.
    expect(lessonPageOf(rows, "x")?.lesson.number).toBe(2);
  });

  it("cada fila dice si está sin empezar, a medias o terminada, y el temario cuántas van (T-206)", () => {
    const seen = { coveredSeconds: 30, position: 30, completed: false, sameVideo: true };
    const rows = [
      row(1, 1, { progress: { ...seen, coveredSeconds: 60, completed: true } }),
      row(1, 2, { progress: seen }),
      row(2, 3, { progress: { ...seen, sameVideo: false } }),
      row(2, 4, { progress: { ...seen, completed: true, sameVideo: false } }),
    ];
    const page = lessonPageOf(rows, "l2");
    expect(page?.modules.flatMap((group) => group.lessons.map((lesson) => lesson.state))).toEqual(["completed", "in_progress", "not_started", "completed"]);
    expect(page?.progress).toEqual({ completed: 2, total: 4 });
  });
});
