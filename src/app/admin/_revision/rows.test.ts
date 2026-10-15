import { describe, expect, it } from "vitest";

import type { ReviewCourse } from "@/services/review/review";

import { playLength, reviewView } from "./rows";

// Lo que la pantalla de revisión pinta, en palabras. Puro.

const COURSE = "c0000000-0000-4000-8000-000000000002";
const lesson = (n: number, module: string, video: ReviewCourse["lessons"][number]["video"]) => ({
  lessonId: `d0000000-0000-4000-8000-00000000000${n}`,
  // El id del módulo sale de su título: dos títulos iguales en módulos distintos se prueban aparte.
  moduleId: module === "Uno" ? "e0000000-0000-4000-8000-000000000001" : "e0000000-0000-4000-8000-000000000002",
  module,
  title: `Lección ${n}`,
  durationSeconds: 356,
  video,
});
const COURSE_ROW: ReviewCourse = {
  courseId: COURSE,
  title: "Naturaleza",
  teacherName: "Ana Robles",
  teacherListed: false,
  practice: "Respiración",
  level: null,
  lessonCount: 4,
  totalDurationSeconds: 3723,
  loadedAt: "2026-10-14T18:00:00Z",
  lessons: [lesson(1, "Uno", "playable"), lesson(2, "Uno", "test"), lesson(3, "Dos", "processing"), lesson(4, "Dos", "errored")],
};

describe("playLength", () => {
  it.each([
    [0, "0:00"],
    [59, "0:59"],
    [356, "5:56"],
    [3723, "1:02:03"],
    [-1, ""],
    [1.5, ""],
  ])("%s segundos: «%s»", (seconds, expected) => {
    expect(playLength(seconds)).toBe(expected);
  });
});

describe("reviewView", () => {
  const view = reviewView({ freshCode: false, courses: [COURSE_ROW] });
  const course = view.teachers[0]?.courses[0];

  it("se ofrece aprobar solo con el código reciente", () => {
    expect(view.canChange).toBe(false);
    expect(reviewView({ freshCode: true, courses: [] }).canChange).toBe(true);
  });

  it("el curso, en palabras, con lo que no tiene dicho como tal", () => {
    expect(view.teachers[0]?.name).toBe("Ana Robles");
    expect(course).toMatchObject({
      id: COURSE,
      title: "Naturaleza",
      practiceAndLevel: "Práctica: Respiración. Nivel: sin definir.",
      lessons: "4 lecciones, 1:02:03 en total.",
      loaded: "Cargado el 14 de octubre de 2026.",
      buttons: { ask: `ask:${COURSE}`, confirm: `confirm:${COURSE}` },
    });
  });

  it("si es el primer curso del maestro, la confirmación lo dice; si ya está listado, no", () => {
    expect(course?.firstOfTeacher).toBe("Es el primer curso de Ana Robles: su ficha también aparece en el catálogo.");
    expect(reviewView({ freshCode: true, courses: [{ ...COURSE_ROW, teacherListed: true }] }).teachers[0]?.courses[0]?.firstOfTeacher).toBeNull();
  });

  it("las lecciones, por módulo y en orden; solo la de Mux lista se puede ver", () => {
    expect(course?.modules.map((each) => [each.title, each.lessons.map((row) => [row.title, row.playable, row.status])])).toEqual([
      [
        "Uno",
        [
          ["Lección 1", true, null],
          ["Lección 2", false, "Sin video en Mux."],
        ],
      ],
      [
        "Dos",
        [
          ["Lección 3", false, "El video se está procesando. Puede tardar unos minutos."],
          ["Lección 4", false, "El video no se pudo procesar."],
        ],
      ],
    ]);
    expect(course?.modules[0]?.lessons[0]).toMatchObject({ length: "5:56", detail: "«Lección 1»" });
  });

  it("cada lección sabe de qué curso y de qué maestro es: lo dice el reproductor", () => {
    expect(course?.modules[0]?.lessons[0]?.context).toBe("Del curso «Naturaleza», de Ana Robles.");
  });

  it("por maestro y, dentro, por curso: los maestros en el orden de su curso más antiguo, sin importar cómo lleguen", () => {
    const of = (id: string, title: string, teacherName: string, day: number): ReviewCourse => ({
      ...COURSE_ROW,
      courseId: id,
      title,
      teacherName,
      loadedAt: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`,
    });
    // Desordenados a propósito: el orden lo pone la pantalla.
    const grouped = reviewView({
      freshCode: true,
      courses: [
        of("c0000000-0000-4000-8000-000000000014", "Dormir", "Ana", 9),
        of("c0000000-0000-4000-8000-000000000013", "Río", "Beto", 6),
        of("c0000000-0000-4000-8000-000000000012", "Respirar", "Ana", 3),
        of("c0000000-0000-4000-8000-000000000011", "Bosque", "Beto", 1),
      ],
    });
    expect(grouped.teachers.map((teacher) => [teacher.name, teacher.courses.map((each) => each.title)])).toEqual([
      ["Beto", ["Bosque", "Río"]],
      ["Ana", ["Respirar", "Dormir"]],
    ]);
  });

  it("el mismo día, desempata el id del curso", () => {
    const of = (id: string, title: string): ReviewCourse => ({ ...COURSE_ROW, courseId: id, title });
    const tied = reviewView({ freshCode: true, courses: [of("c0000000-0000-4000-8000-000000000022", "Segundo"), of("c0000000-0000-4000-8000-000000000021", "Primero")] });
    expect(tied.teachers[0]?.courses.map((each) => each.title)).toEqual(["Primero", "Segundo"]);
  });

  it("un nombre escrito distinto pero igual a la vista es el mismo maestro", () => {
    const decomposed = "Ana Pe\u0301rez";
    const grouped = reviewView({
      freshCode: true,
      courses: [
        { ...COURSE_ROW, courseId: "c0000000-0000-4000-8000-000000000031", teacherName: "Ana Pérez" },
        { ...COURSE_ROW, courseId: "c0000000-0000-4000-8000-000000000032", teacherName: ` ${decomposed}  ` },
      ],
    });
    expect(grouped.teachers.map((teacher) => [teacher.name, teacher.courses.length])).toEqual([["Ana Pérez", 2]]);
  });

  it("sin cursos, sin maestros", () => {
    expect(reviewView({ freshCode: true, courses: [] }).teachers).toEqual([]);
  });

  it("dos módulos con el mismo título no se juntan: se agrupa por su id", () => {
    const twin = { ...lesson(3, "Uno", "playable"), moduleId: "e0000000-0000-4000-8000-000000000009" };
    const view2 = reviewView({ freshCode: true, courses: [{ ...COURSE_ROW, lessons: [lesson(1, "Uno", "playable"), twin] }] });
    expect(view2.teachers[0]?.courses[0]?.modules.map((each) => [each.title, each.lessons.length])).toEqual([
      ["Uno", 1],
      ["Uno", 1],
    ]);
  });

  it("una lección de un curso de una lección: «lección», en singular", () => {
    const one = reviewView({ freshCode: true, courses: [{ ...COURSE_ROW, lessonCount: 1, totalDurationSeconds: 356, lessons: [lesson(1, "Uno", "playable")] }] });
    expect(one.teachers[0]?.courses[0]?.lessons).toBe("1 lección, 5:56 en total.");
  });
});
