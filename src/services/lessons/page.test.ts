import { describe, expect, it } from "vitest";

import { lessonPageOf, type LessonRowData } from "./page";

// La página de una lección (PA-22) armada con sus filas: el temario por módulos en su orden,
// la lección pedida y la siguiente.

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
          { id: "l1", title: "Lección 1", number: 1, durationSeconds: 60, current: false },
          { id: "l2", title: "Lección 2", number: 2, durationSeconds: 120, current: false },
        ],
      },
      {
        id: "m2",
        title: "Módulo 2",
        lessons: [
          { id: "l3", title: "Lección 3", number: 3, durationSeconds: 180, current: true },
          { id: "l4", title: "Lección 4", number: 4, durationSeconds: 240, current: false },
        ],
      },
    ]);
    expect(page?.lessonCount).toBe(4);
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
});
