import { describe, expect, it } from "vitest";

import type { TeacherCourse } from "@/services/drafts/editor";

import { courseRows } from "./rows";

// Lo que PA-42 pinta de cada curso, ya en palabras (T-402).

const DRAFT = "c0000000-0000-4000-8000-000000000001";
const PUBLISHED = "c0000000-0000-4000-8000-000000000002";

const draft: TeacherCourse = {
  id: DRAFT,
  state: "draft",
  pendingVersion: null,
  title: "Respirar",
  updatedAt: "2026-10-29T18:00:00.000Z",
  contentRevision: 3,
  teacherName: "Ana Ruiz",
  practiceName: "Respiración",
  coverTone: 3,
  lessonCount: 2,
  slug: null,
  draft: { hasSummary: false, practiceReady: true, levelReady: true, lessons: 2, lessonsWithoutVideo: 2, modulesWithLessons: 1 },
  returned: null,
  missing: null,
  submittedAt: null,
};
const published: TeacherCourse = {
  id: PUBLISHED,
  state: "published",
  pendingVersion: null,
  title: "El bosque",
  updatedAt: "2026-10-01T18:00:00.000Z",
  contentRevision: null,
  teacherName: "Ana Ruiz",
  practiceName: null,
  coverTone: null,
  lessonCount: 4,
  slug: "el-bosque",
  draft: null,
  returned: null,
  missing: null,
  submittedAt: null,
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
    const one = courseRows([{ ...draft, draft: { hasSummary: true, practiceReady: true, levelReady: false, lessons: 0, lessonsWithoutVideo: 0, modulesWithLessons: 1 } }], false);
    expect(one[0]?.detail).toBe("Falta 1 cosa para enviarlo");
    const none = courseRows([{ ...draft, draft: { hasSummary: true, practiceReady: true, levelReady: true, lessons: 0, lessonsWithoutVideo: 0, modulesWithLessons: 1 } }], false);
    expect(none[0]?.detail).toBe("Listo para enviar");
  });

  it("al suspendido: «Ver» en lugar de editar, y nunca borrar", () => {
    const [row] = courseRows([draft], true);
    expect(row?.action).toEqual({ label: "Ver", href: `/portal/cursos/${DRAFT}`, name: "Ver Respirar" });
    expect(row?.remove).toBeNull();
  });

  it("un curso publicado: «Editar» lleva a su editor, el enlace a su ficha y sus lecciones, y no se borra (diseño, PA-42; T-405)", () => {
    const [row] = courseRows([published], false);
    expect(row).toMatchObject({ state: "Publicado", detail: null, lessons: "4 lecciones", remove: null });
    expect(row?.action).toEqual({ label: "Editar", href: `/portal/cursos/${PUBLISHED}`, name: "Editar El bosque" });
    expect(row?.publicPage).toEqual({ label: "Ver su ficha", href: "/cursos/el-bosque", name: "Ver la ficha de El bosque" });
    expect(row?.cover).toEqual({ title: "El bosque", teacherName: "Ana Ruiz", practiceName: null, tone: null });
  });

  it("al suspendido, un curso publicado se ve, sin «Editar»", () => {
    expect(courseRows([published], true)[0]?.action).toMatchObject({ label: "Ver" });
  });

  it("un curso despublicado se ve, sin su ficha", () => {
    const [row] = courseRows([{ ...published, state: "withdrawn" }], false);
    expect(row).toMatchObject({ state: "Despublicado", publicPage: null });
    expect(row?.action).toMatchObject({ label: "Ver", href: `/portal/cursos/${PUBLISHED}` });
  });

  it("un borrador que ya se envió no se borra", () => {
    const [row] = courseRows([{ ...draft, state: "in_review" }], false);
    expect(row).toMatchObject({ state: "En revisión", detail: "No se puede editar mientras está en revisión.", remove: null });
    expect(row?.action?.label).toBe("Ver");
  });
});

describe("un curso que Contenido devolvió (FL-35)", () => {
  const returned: TeacherCourse = { ...draft, returned: { reason: "El audio se corta.", whatToFix: "Vuelve a subirla.", returnedAt: "2026-11-02T18:00:00.000Z" } };

  it("dice «Rechazado» y su motivo, y se corrige", () => {
    const [row] = courseRows([returned], false);
    expect(row).toMatchObject({ state: "Rechazado", tone: "bad", detail: "El audio se corta.", detailIsReason: true });
    expect(row?.action).toMatchObject({ label: "Corregir", name: "Corregir Respirar" });
  });

  it("se puede borrar: la prueba se queda en la base", () => {
    expect(courseRows([returned], false)[0]?.remove).not.toBeNull();
  });

  it("al suspendido se le ofrece ver, nunca corregir ni borrar", () => {
    const [row] = courseRows([returned], true);
    expect(row?.action).toMatchObject({ label: "Ver", name: "Ver Respirar" });
    expect(row?.remove).toBeNull();
  });

  it("un borrador sin devolver sigue como siempre", () => {
    expect(courseRows([draft], false)[0]).toMatchObject({ state: "Borrador", tone: "neutral", detailIsReason: false });
  });
});

describe("lo que falta, con la lista de enviar", () => {
  const ready = { ...draft, draft: { hasSummary: true, practiceReady: true, levelReady: true, lessons: 2, lessonsWithoutVideo: 0, modulesWithLessons: 1 } };

  it("el número es el de la regla; la lista de enviar no lo cambia", () => {
    expect(courseRows([{ ...draft, missing: 5 }], false)[0]?.detail).toBe("Faltan 3 cosas para enviarlo");
  });

  it("si la regla no ve nada y la lista de enviar sí, no dice «Listo»", () => {
    expect(courseRows([{ ...ready, missing: 1 }], false)[0]?.detail).toBe("Falta 1 cosa para enviarlo");
  });

  it("con las dos de acuerdo, «Listo para enviar»", () => {
    expect(courseRows([{ ...ready, missing: 0 }], false)[0]?.detail).toBe("Listo para enviar");
    expect(courseRows([{ ...ready, missing: null }], false)[0]?.detail).toBe("Listo para enviar");
  });

  it("en revisión, la fecha de envío", () => {
    expect(courseRows([{ ...draft, state: "in_review", submittedAt: "2026-11-02T18:00:00.000Z" }], false)[0]?.detail).toMatch(/^Enviado el /);
  });
});


describe("la versión de un curso publicado (T-405, FL-36)", () => {
  const version: TeacherCourse = { ...draft, id: PUBLISHED, state: "changes_pending", pendingVersion: "draft", title: "El bosque" };

  it("en borrador: con cambios pendientes, que los alumnos ven lo publicado, y «Seguir editando», sin borrar (diseño, PA-42)", () => {
    const [row] = courseRows([{ ...version, slug: "el-bosque" }], false);
    expect(row).toMatchObject({ state: "Con cambios pendientes", tone: "active", detail: "Tus alumnos ven la versión publicada.", lessons: "2 lecciones", remove: null });
    expect(row?.action).toEqual({ label: "Seguir editando", href: `/portal/cursos/${PUBLISHED}`, name: "Seguir editando El bosque" });
    expect(row?.publicPage?.href).toBe("/cursos/el-bosque");
  });

  it("devuelta: «Rechazado», su motivo y corregir, sin borrar", () => {
    const [row] = courseRows([{ ...version, returned: { reason: "Falta el cierre.", whatToFix: "Agrégalo.", returnedAt: "2026-11-02T18:00:00.000Z" } }], false);
    expect(row).toMatchObject({ state: "Rechazado", tone: "bad", detail: "Falta el cierre.", detailIsReason: true, remove: null });
    expect(row?.action?.label).toBe("Corregir");
  });

  it("enviada sin la fecha: dice en revisión, también en la línea de detalle", () => {
    expect(courseRows([{ ...version, pendingVersion: "in_review" }], false)[0]?.detail).toBe("No se puede editar mientras está en revisión.");
  });

  it("enviada: en revisión, con la fecha de envío, y solo ver", () => {
    const [row] = courseRows([{ ...version, pendingVersion: "in_review", submittedAt: "2026-11-02T18:00:00.000Z" }], false);
    expect(row).toMatchObject({ state: "En revisión", tone: "attention", remove: null });
    expect(row?.detail).toMatch(/^Enviado el /);
    expect(row?.action?.label).toBe("Ver");
  });

  it("al suspendido, ver", () => {
    expect(courseRows([version], true)[0]?.action?.label).toBe("Ver");
  });
});
