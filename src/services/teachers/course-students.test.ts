import { describe, expect, it } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import type { FailureCode } from "@/services/error-reporting/server";

import { createCourseStudents, type CourseStudentsStore, type StudentsQuery } from "./course-students";
import { askCourseStudents } from "./course-students-records";

// El servicio del avance de los alumnos de un curso (PA-51, T-408), con la base simulada: lo que se acepta de `private.teacher_course_students` (la
// forma exacta y nada más), lo que no se le pregunta y «no se supo». Lo que la base decide lo prueba la 83, y el camino contra la base local, la 111.

const claims = { sub: "a0000000-0000-4000-8000-000000000001" } as unknown as VerifiedClaims;
const COURSE = "c0000000-0000-4000-8000-000000000001";

const OK = {
  outcome: "ok",
  title: "Respirar para volver",
  figures: { started: 41, in_progress: 29, finished: 12, cut_at: "2031-03-12T06:00:00+00:00" },
  lessons: [
    { title: "Uno", finished: 30 },
    { title: "Dos", finished: 12 },
  ],
  students: [
    { alias: "Garza 42", completed: 2, total: 2 },
    { alias: "Lerma 17", completed: 0, total: 2 },
  ],
  page: 1,
  pages: 1,
  total_students: 2,
  list_cut_at: "2031-03-10T06:00:00+00:00",
  stale: false,
};

/** Una transacción que contesta lo que se le diga, pasándolo por la forma de la fila como la de verdad, y que anota lo que se le preguntó. */
function txAnswering(answer: unknown) {
  const asked: unknown[][] = [];
  const tx = {
    query: (query: { values: unknown[] }, row: { parse: (value: unknown) => unknown }) => {
      asked.push([...query.values]);
      return Promise.resolve([row.parse({ answer })]);
    },
  } as unknown as Tx;
  return { tx, asked };
}

const query: StudentsQuery = { course: COURSE, order: "progress", page: 1 };

describe("la lectura de la base", () => {
  it("traduce la respuesta: las fechas como ISO y las cifras con su nombre", async () => {
    const { tx, asked } = txAnswering(OK);
    expect(await askCourseStudents(tx, { course: COURSE, order: "alias", page: 3 })).toEqual({
      outcome: "ok",
      value: {
        title: "Respirar para volver",
        figures: { started: 41, inProgress: 29, finished: 12, cutAt: "2031-03-12T06:00:00.000Z" },
        lessons: [
          { title: "Uno", finished: 30 },
          { title: "Dos", finished: 12 },
        ],
        students: [
          { alias: "Garza 42", completed: 2, total: 2 },
          { alias: "Lerma 17", completed: 0, total: 2 },
        ],
        page: 1,
        pages: 1,
        totalStudents: 2,
        listCutAt: "2031-03-10T06:00:00.000Z",
        stale: false,
      },
    });
    expect(asked).toEqual([[COURSE, "alias", 3]]);
  });

  it("antes de la primera noche: sin cifras, sin lista y con el aviso", async () => {
    const answer = {
      ...OK,
      figures: null,
      lessons: [{ title: "Uno", finished: null }],
      students: [],
      total_students: 0,
      list_cut_at: null,
      stale: true,
    };
    expect(await askCourseStudents(txAnswering(answer).tx, query)).toEqual({
      outcome: "ok",
      value: {
        title: "Respirar para volver",
        figures: null,
        lessons: [{ title: "Uno", finished: null }],
        students: [],
        page: 1,
        pages: 1,
        totalStudents: 0,
        listCutAt: null,
        stale: true,
      },
    });
  });

  it.each(["not_teacher", "not_found"])("%s pasa tal cual", async (outcome) => {
    expect(await askCourseStudents(txAnswering({ outcome }).tx, query)).toEqual({ outcome });
  });

  it.each<[string, unknown]>([
    ["una clave de más arriba", { ...OK, teacher_id: COURSE }],
    ["algo de un alumno de más", { ...OK, students: [{ ...OK.students[0], profile_id: COURSE }] }],
    ["una fecha por alumno", { ...OK, students: [{ ...OK.students[0], last_activity_at: "2031-03-01T00:00:00Z" }] }],
    ["una clave de más en las cifras", { ...OK, figures: { ...OK.figures, students: 3 } }],
    ["una clave de más en una lección", { ...OK, lessons: [{ ...OK.lessons[0], lesson_id: COURSE }] }],
    ["un alias sin forma", { ...OK, students: [{ ...OK.students[0], alias: "ana@correo.mx" }] }],
    ["un nombre en lugar del alias", { ...OK, students: [{ ...OK.students[0], alias: "Ana López" }] }],
    ["más terminadas que lecciones", { ...OK, students: [{ ...OK.students[0], completed: 3 }] }],
    ["cifras que no suman", { ...OK, figures: { ...OK.figures, finished: 13 } }],
    ["cifras sin lecciones con cifra", { ...OK, lessons: [{ title: "Uno", finished: null }] }],
    ["lecciones con cifra sin cifras", { ...OK, figures: null }],
    ["alumnos sin lista", { ...OK, list_cut_at: null }],
    ["una página de más", { ...OK, page: 2 }],
    ["más de 50 alumnos en una página", { ...OK, students: Array.from({ length: 51 }, (_, i) => ({ alias: `Garza ${10 + i}`, completed: 0, total: 2 })) }],
    ["una cifra negativa", { ...OK, figures: { started: -1, in_progress: 0, finished: -1, cut_at: OK.figures.cut_at } }],
    ["una fecha que no se entiende", { ...OK, list_cut_at: "el lunes" }],
    ["sin decir si es viejo", { ...OK, stale: undefined }],
    ["un resultado que no conoce", { outcome: "closed" }],
    ["nada", undefined],
  ])("%s no tiene forma: falla", async (_name, answer) => {
    await expect(askCourseStudents(txAnswering(answer).tx, query)).rejects.toThrow();
  });
});

function harness(store: CourseStudentsStore) {
  const reported: FailureCode[] = [];
  const asked: StudentsQuery[] = [];
  const service = createCourseStudents({
    store: {
      read: (given, q) => {
        asked.push(q);
        return store.read(given, q);
      },
    },
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
  return { service, reported, asked };
}

describe("el servicio", () => {
  it("le pregunta a la base con las claims de la guarda y devuelve lo que contestó", async () => {
    const seen: VerifiedClaims[] = [];
    const { service, reported, asked } = harness({
      read: (given) => {
        seen.push(given);
        return Promise.resolve({ outcome: "not_found" });
      },
    });
    expect(await service.courseStudents(claims, query)).toEqual({ kind: "ready", value: { outcome: "not_found" } });
    expect(seen).toEqual([claims]);
    expect(asked).toEqual([query]);
    expect(reported).toEqual([]);
  });

  it("un curso sin forma de identificador no se le pregunta a la base: no existe", async () => {
    const { service, asked } = harness({ read: () => Promise.reject(new Error("no debió preguntar")) });
    expect(await service.courseStudents(claims, { ...query, course: "uno" })).toEqual({ kind: "ready", value: { outcome: "not_found" } });
    expect(await service.courseStudents(claims, { ...query, course: COURSE.toUpperCase() })).toEqual({ kind: "ready", value: { outcome: "not_found" } });
    expect(asked).toEqual([]);
  });

  it("la página va de 1 en adelante, entera y con tope", async () => {
    const { service, asked } = harness({ read: () => Promise.resolve({ outcome: "not_found" }) });
    for (const page of [0, -3, 2.5, Number.NaN, 1e9]) await service.courseStudents(claims, { ...query, page });
    expect(asked.map((q) => q.page)).toEqual([1, 1, 2, 1, 10_000]);
  });

  it("si la base no contesta, o contesta sin forma, «no se supo», y se reporta", async () => {
    const { service, reported } = harness({ read: () => Promise.reject(new Error("caída")) });
    expect(await service.courseStudents(claims, query)).toEqual({ kind: "unavailable" });
    expect(reported).toEqual(["course_students_unavailable"]);
  });
});
