import { describe, expect, it } from "vitest";

import { CONTINUE_LIMIT, continueWatchingOf, type ContinueRowData } from "./continue";

// «Continuar viendo» armado con sus filas (RF-301, RF-307, FL-13; T-206): los cursos empezados y
// sin terminar, el más reciente primero, cada uno con cuántas lleva y la lección sugerida.

const row = (course: string, lesson: number, overrides: Partial<ContinueRowData> = {}): ContinueRowData => ({
  courseSlug: course,
  courseTitle: `Curso ${course}`,
  teacherName: "Ana Robles",
  lastWatchedAt: new Date("2026-10-20T12:00:00Z"),
  lastLessonId: `${course}-1`,
  lessonId: `${course}-${lesson}`,
  lessonTitle: `Lección ${lesson}`,
  modulePosition: 1,
  lessonPosition: lesson,
  completed: false,
  ...overrides,
});

describe("continuar viendo", () => {
  it("un curso empezado: cuántas lleva, y la lección sugerida con su número", () => {
    const rows = [row("a", 2), row("a", 1, { completed: true }), row("a", 3)].map((each) => ({ ...each, lastLessonId: "a-1" }));
    expect(continueWatchingOf(rows)).toEqual([
      { courseSlug: "a", courseTitle: "Curso a", teacherName: "Ana Robles", completed: 1, total: 3, lesson: { id: "a-2", title: "Lección 2", number: 2 } },
    ]);
  });

  it("la sugerida es la última que vio si no la terminó", () => {
    const rows = [row("a", 1), row("a", 2), row("a", 3)].map((each) => ({ ...each, lastLessonId: "a-3" }));
    expect(continueWatchingOf(rows)[0]?.lesson).toEqual({ id: "a-3", title: "Lección 3", number: 3 });
  });

  it("si la que vio ya no está en el temario, la primera sin terminar (FL-13 A2)", () => {
    const rows = [row("a", 1, { completed: true }), row("a", 2)].map((each) => ({ ...each, lastLessonId: "retirada" }));
    expect(continueWatchingOf(rows)[0]?.lesson.id).toBe("a-2");
  });

  it("el orden del temario es por módulo y después por lección", () => {
    const rows = [row("a", 1, { modulePosition: 2, lessonTitle: "Del segundo" }), row("a", 5, { modulePosition: 1 })].map((each) => ({
      ...each,
      lastLessonId: null,
    }));
    expect(continueWatchingOf(rows)[0]?.lesson).toEqual({ id: "a-5", title: "Lección 5", number: 1 });
  });

  it("un curso terminado sale de la fila (FL-13 A3)", () => {
    const rows = [row("a", 1, { completed: true }), row("a", 2, { completed: true }), row("b", 1)];
    expect(continueWatchingOf(rows).map((each) => each.courseSlug)).toEqual(["b"]);
  });

  it("el más reciente primero", () => {
    const rows = [
      row("viejo", 1, { lastWatchedAt: new Date("2026-10-01T00:00:00Z") }),
      row("nuevo", 1, { lastWatchedAt: new Date("2026-10-19T00:00:00Z") }),
      row("medio", 1, { lastWatchedAt: new Date("2026-10-10T00:00:00Z") }),
    ];
    expect(continueWatchingOf(rows).map((each) => each.courseSlug)).toEqual(["nuevo", "medio", "viejo"]);
  });

  it(`a lo más ${CONTINUE_LIMIT} cursos`, () => {
    const rows = Array.from({ length: CONTINUE_LIMIT + 5 }, (_, index) =>
      row(`c${index}`, 1, { lastWatchedAt: new Date(Date.UTC(2026, 9, 1) + index * 60_000) }),
    );
    const answer = continueWatchingOf(rows);
    expect(answer).toHaveLength(CONTINUE_LIMIT);
    expect(answer[0]?.courseSlug).toBe(`c${CONTINUE_LIMIT + 4}`);
  });

  it("sin filas, nada", () => {
    expect(continueWatchingOf([])).toEqual([]);
  });
});
