import { describe, expect, it } from "vitest";

import type { CourseStudentsValue } from "@/services/teachers/course-students-data";

import { studentsQuery, studentsView } from "./rows";

// La tabla pura de PA-51 (T-408): qué se pinta con lo que contestó la base, ya en palabras, y qué se le pregunta según la dirección.

const COURSE = "c0000000-0000-4000-8000-000000000001";

const VALUE: CourseStudentsValue = {
  title: "Respirar para volver",
  figures: { started: 1_041, inProgress: 1_029, finished: 12, cutAt: "2031-03-12T06:00:00.000Z" },
  lessons: [
    { title: "Respirar", finished: 1_030 },
    { title: "Soltar", finished: 12 },
  ],
  students: [
    { alias: "Garza 42", completed: 2, total: 2 },
    { alias: "Lerma 17", completed: 0, total: 2 },
  ],
  page: 2,
  pages: 3,
  totalStudents: 120,
  listCutAt: "2031-03-10T06:00:00.000Z",
  stale: false,
};

describe("la dirección", () => {
  it.each<[Record<string, string | string[] | undefined>, { order: string; page: number }]>([
    [{}, { order: "progress", page: 1 }],
    [{ orden: "alias" }, { order: "alias", page: 1 }],
    [{ orden: "otro", pagina: "3" }, { order: "progress", page: 3 }],
    [{ pagina: "dos" }, { order: "progress", page: 1 }],
    [{ pagina: "-2" }, { order: "progress", page: 1 }],
    [{ pagina: "0" }, { order: "progress", page: 1 }],
    [{ orden: ["alias", "progress"], pagina: ["2", "4"] }, { order: "progress", page: 1 }],
  ])("%j se lee como %j", (search, expected) => {
    expect(studentsQuery(COURSE, search)).toEqual({ course: COURSE, ...expected });
  });
});

describe("la vista", () => {
  it("las cifras, con su corte en el día anterior a la medianoche que lo cerró", () => {
    const view = studentsView(COURSE, VALUE, "progress");
    expect(view.title).toBe("Respirar para volver");
    expect(view.figuresAt).toBe("Cifras hasta el 11 de marzo de 2031. Se actualizan cada noche.");
    expect(view.notice).toBeNull();
    expect(view.nobody).toBe(false);
    expect(view.tiles).toEqual({ started: "1,041", inProgress: "1,029", finished: "12" });
  });

  it("las lecciones, numeradas en el orden del temario y medidas contra quienes empezaron", () => {
    const view = studentsView(COURSE, VALUE, "progress");
    expect(view.lessons).toEqual([
      { key: "leccion-1", label: "1. Respirar", value: 1_030, amount: "1,030" },
      { key: "leccion-2", label: "2. Soltar", value: 12, amount: "12" },
    ]);
    expect(view.funnelMax).toBe(1_041);
  });

  it("la lista: alias, «2 de 2» y su barra, con el lunes de la lista y sus páginas", () => {
    const view = studentsView(COURSE, VALUE, "progress");
    expect(view.list.at).toBe("Lista hasta el 9 de marzo de 2031. Se actualiza cada lunes.");
    expect(view.list.rows).toEqual([
      { key: "alumno-1", alias: "Garza 42", completed: "2 de 2", value: 2, max: 2 },
      { key: "alumno-2", alias: "Lerma 17", completed: "0 de 2", value: 0, max: 2 },
    ]);
    expect(view.list.pending).toBeNull();
    expect(view.list.page).toBe("Página 2 de 3");
    expect(view.list.previous).toBe(`/portal/cursos/${COURSE}/alumnos`);
    expect(view.list.next).toBe(`/portal/cursos/${COURSE}/alumnos?pagina=3`);
  });

  it("el orden: el que se ve no enlaza, y cambiarlo vuelve a la primera página", () => {
    expect(studentsView(COURSE, VALUE, "progress").list.orders).toEqual([
      { key: "progress", label: "Por avance", href: null },
      { key: "alias", label: "Por alias", href: `/portal/cursos/${COURSE}/alumnos?orden=alias` },
    ]);
    const byAlias = studentsView(COURSE, VALUE, "alias");
    expect(byAlias.list.orders).toEqual([
      { key: "progress", label: "Por avance", href: `/portal/cursos/${COURSE}/alumnos` },
      { key: "alias", label: "Por alias", href: null },
    ]);
    expect(byAlias.list.next).toBe(`/portal/cursos/${COURSE}/alumnos?orden=alias&pagina=3`);
    expect(byAlias.list.previous).toBe(`/portal/cursos/${COURSE}/alumnos?orden=alias`);
  });

  it("una sola página no lleva paginación", () => {
    const list = studentsView(COURSE, { ...VALUE, page: 1, pages: 1 }, "progress").list;
    expect([list.page, list.previous, list.next]).toEqual([null, null, null]);
  });

  it("antes de la primera noche: sin cifras, con el aviso y sin lista", () => {
    const view = studentsView(
      COURSE,
      { ...VALUE, figures: null, lessons: [{ title: "Respirar", finished: null }], students: [], page: 1, pages: 1, totalStudents: 0, listCutAt: null, stale: true },
      "progress",
    );
    expect(view.figuresAt).toBeNull();
    expect(view.notice).toEqual({ tone: "neutral", text: "Todavía no hay cifras de este curso: se calculan cada noche." });
    expect(view.tiles).toEqual({ started: null, inProgress: null, finished: null });
    expect(view.lessons).toEqual([{ key: "leccion-1", label: "1. Respirar", value: null, amount: null }]);
    expect(view.list.at).toBeNull();
    expect(view.list.pending).toBe("La lista se arma cada lunes: quien empezó después aparece en la siguiente.");
  });

  it("un resumen viejo se dice, con la fecha de lo que se ve", () => {
    expect(studentsView(COURSE, { ...VALUE, stale: true }, "progress").notice).toEqual({
      tone: "warning",
      text: "No se pudieron actualizar las cifras de anoche. Estas son hasta el 11 de marzo de 2031.",
    });
  });

  it("nadie lo ha empezado: lo dice", () => {
    const view = studentsView(COURSE, { ...VALUE, figures: { ...VALUE.figures!, started: 0, inProgress: 0, finished: 0 }, students: [], totalStudents: 0 }, "progress");
    expect(view.nobody).toBe(true);
  });

  it("con cifras y sin nadie en la lista del lunes: la lista lo explica", () => {
    expect(studentsView(COURSE, { ...VALUE, students: [], totalStudents: 0, page: 1, pages: 1 }, "progress").list.pending).toBe(
      "La lista se arma cada lunes: quien empezó después aparece en la siguiente.",
    );
  });
});
