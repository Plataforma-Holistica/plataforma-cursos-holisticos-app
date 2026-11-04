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
  description: null,
  resources: [],
});
const COURSE_ROW: ReviewCourse = {
  courseId: COURSE,
  title: "Naturaleza",
  summary: null,
  teacherName: "Ana Robles",
  teacherListed: false,
  practice: "Respiración",
  level: null,
  lessonCount: 4,
  totalDurationSeconds: 3723,
  loadedAt: "2026-10-14T18:00:00Z",
  lessons: [lesson(1, "Uno", "playable"), lesson(2, "Uno", "test"), lesson(3, "Dos", "processing"), lesson(4, "Dos", "errored")],
  submission: null,
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

describe("lo enviado por el portal", () => {
  const SUBMISSION = "f0000000-0000-4000-8000-000000000001";
  const SENT: ReviewCourse = {
    ...COURSE_ROW,
    summary: "Un resumen.",
    lessons: [{ ...lesson(1, "Uno", "playable"), description: "De qué trata.", resources: [{ id: "a1000000-0000-4000-8000-000000000001", title: "Guía", kind: "pdf", sizeBytes: 2048 }] }],
    submission: {
      id: SUBMISSION,
      number: 2,
      resources: [{ id: "a1000000-0000-4000-8000-000000000002", title: "Temario", kind: "pdf", sizeBytes: 1024 }],
      annex: { version: 3, acceptedAt: "2026-11-02T18:00:00Z", statement: "Acepto el anexo.", termYears: 10 },
      captionsMissing: [],
      filesChanged: [],
      version: 1,
      isRevision: false,
      changes: null,
    },
  };
  const rowOf = (course: ReviewCourse) => reviewView({ freshCode: true, courses: [course] }).teachers[0]?.courses[0];

  it("dice cuándo se envió y qué número de envío es, no cuándo se cargó", () => {
    expect(rowOf(SENT)?.loaded).toMatch(/^Enviado el .* Envío número 2\.$/);
    expect(rowOf(SENT)?.summary).toBe("Un resumen.");
  });

  it("el anexo: versión, fecha y plazo, y la frase aceptada", () => {
    expect(rowOf(SENT)?.submission?.annex).toMatch(/^Versión 3, aceptada el .*, por 10 años\.$/);
    expect(rowOf(SENT)?.submission?.statement).toBe("Acepto el anexo.");
  });

  it("un plazo de un año, en singular", () => {
    const one: ReviewCourse = { ...SENT, submission: { ...SENT.submission!, annex: { ...SENT.submission!.annex, termYears: 1 } } };
    expect(rowOf(one)?.submission?.annex).toMatch(/por 1 año\.$/);
  });

  it("los botones llevan el curso y el envío que se vio", () => {
    expect(rowOf(SENT)?.submission?.ask).toBe(`return_ask:${COURSE}:${SUBMISSION}`);
    expect(rowOf(SENT)?.buttons).toEqual({ ask: `ask:${COURSE}:${SUBMISSION}`, confirm: `confirm:${COURSE}:${SUBMISSION}` });
    expect(rowOf(COURSE_ROW)?.buttons).toEqual({ ask: `ask:${COURSE}`, confirm: `confirm:${COURSE}` });
  });

  it("dice qué lecciones esperan sus subtítulos, por su título; sin ninguna, nada", () => {
    expect(rowOf(SENT)?.submission?.captions).toBeNull();
    const waiting: ReviewCourse = { ...SENT, submission: { ...SENT.submission!, captionsMissing: [SENT.lessons[0]!.lessonId] } };
    expect(rowOf(waiting)?.submission?.captions).toBe("Sin subtítulos confirmados: «Lección 1». Al aprobar se le pregunta a Mux; sin ellos no se publica.");
  });

  it("dice qué archivo cambió por fuera; sin ninguno, nada", () => {
    expect(rowOf(SENT)?.submission?.files).toBeNull();
    const changed: ReviewCourse = { ...SENT, submission: { ...SENT.submission!, filesChanged: ["Lección 1", "Temario"] } };
    expect(rowOf(changed)?.submission?.files).toMatch(/^Cambió por fuera después de enviarse: «Lección 1», «Temario»\. Así no se publica/);
  });

  it("su video se pide con el curso; el de uno por guion, no", () => {
    expect(rowOf(SENT)?.modules[0]?.lessons[0]?.draftCourse).toBe(COURSE);
    expect(rowOf(COURSE_ROW)?.modules[0]?.lessons[0]?.draftCourse).toBeNull();
  });

  it("sus recursos, ya en palabras, sin nada que se pueda bajar sin la puerta de medios", () => {
    expect(rowOf(SENT)?.modules[0]?.lessons[0]?.resources).toEqual([{ id: "a1000000-0000-4000-8000-000000000001", title: "Guía", detail: expect.stringContaining("2") }]);
    expect(rowOf(SENT)?.submission?.resources.map((each) => each.title)).toEqual(["Temario"]);
  });

  it("uno por guion no tiene envío", () => {
    expect(rowOf(COURSE_ROW)?.submission).toBeNull();
  });
});
