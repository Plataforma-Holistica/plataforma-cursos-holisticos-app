import { describe, expect, it } from "vitest";

import type { TeacherCourse } from "@/services/drafts/editor";

import { courseRows } from "./rows";

// Lo que PA-42 pinta de cada curso, ya en palabras (T-402).

const DRAFT = "c0000000-0000-4000-8000-000000000001";
const PUBLISHED = "c0000000-0000-4000-8000-000000000002";

const draft: TeacherCourse = {
  id: DRAFT,
  state: "draft",
  title: "Respirar",
  updatedAt: "2026-10-29T18:00:00.000Z",
  contentRevision: 3,
  teacherName: "Ana Ruiz",
  practiceName: "Respiración",
  coverTone: 3,
  draft: { hasSummary: false, practiceReady: true, levelReady: true, lessons: 2, modulesWithLessons: 1 },
};
const published: TeacherCourse = {
  id: PUBLISHED,
  state: "published",
  title: "El bosque",
  updatedAt: "2026-10-01T18:00:00.000Z",
  contentRevision: null,
  teacherName: "Ana Ruiz",
  practiceName: null,
  coverTone: null,
  draft: null,
};

describe("courseRows", () => {
  it("un borrador: lo que le falta, sus lecciones, editar y borrar", () => {
    const [row] = courseRows([draft], false);
    expect(row).toMatchObject({
      id: DRAFT,
      title: "Respirar",
      state: "Borrador",
      detail: "Faltan 3 cosas para enviarlo",
      lessons: "2 lecciones",
      edited: "29 de octubre de 2026",
      action: { label: "Editar", href: `/portal/cursos/${DRAFT}`, name: "Editar Respirar" },
      remove: { label: "Borrar", href: `/portal/cursos/${DRAFT}/borrar`, name: "Borrar Respirar" },
      cover: { title: "Respirar", teacherName: "Ana Ruiz", practiceName: "Respiración", tone: 3 },
    });
  });

  it("en singular, y listo para enviar cuando no falta nada", () => {
    const one = courseRows([{ ...draft, draft: { hasSummary: true, practiceReady: true, levelReady: false, lessons: 0, modulesWithLessons: 1 } }], false);
    expect(one[0]?.detail).toBe("Falta 1 cosa para enviarlo");
    const none = courseRows([{ ...draft, draft: { hasSummary: true, practiceReady: true, levelReady: true, lessons: 0, modulesWithLessons: 1 } }], false);
    expect(none[0]?.detail).toBe("Listo para enviar");
  });

  it("al suspendido: «Ver» en lugar de editar, y nunca borrar", () => {
    const [row] = courseRows([draft], true);
    expect(row?.action).toEqual({ label: "Ver", href: `/portal/cursos/${DRAFT}`, name: "Ver Respirar" });
    expect(row?.remove).toBeNull();
  });

  it("un curso sin borrador (los cargados por guion) no se abre en el editor ni se borra", () => {
    const [row] = courseRows([published], false);
    expect(row).toMatchObject({ state: "Publicado", detail: "Tus alumnos ven la versión publicada.", lessons: null, action: null, remove: null });
    expect(row?.cover).toEqual({ title: "El bosque", teacherName: "Ana Ruiz", practiceName: null, tone: null });
  });

  it("un borrador que ya se envió no se borra", () => {
    const [row] = courseRows([{ ...draft, state: "in_review" }], false);
    expect(row).toMatchObject({ state: "En revisión", detail: "No se puede editar mientras está en revisión.", remove: null });
    expect(row?.action?.label).toBe("Ver");
  });
});
