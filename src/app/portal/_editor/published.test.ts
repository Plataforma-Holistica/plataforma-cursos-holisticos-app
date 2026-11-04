import { describe, expect, it } from "vitest";

import type { PublishedCourse } from "@/services/drafts/editor";

import { publishedView } from "./published";

// PA-43 de un curso publicado sin versión abierta (T-405, FL-36 paso 1): lo publicado en solo lectura, y «Editar».

const COURSE = "c0000000-0000-4000-8000-000000000001";
const course: PublishedCourse = {
  id: COURSE,
  state: "published",
  pendingVersion: null,
  title: "El bosque",
  summary: "Caminar despacio.",
  slug: "el-bosque",
  copyable: true,
  modules: [
    { id: "d0000000-0000-4000-8000-000000000001", title: "Inicio", lessons: [{ id: "e0000000-0000-4000-8000-000000000001", title: "Entrar", seconds: 1234 }] },
    { id: "d0000000-0000-4000-8000-000000000002", title: "", lessons: [{ id: "e0000000-0000-4000-8000-000000000002", title: "Salir", seconds: 45 }] },
  ],
};

describe("publishedView", () => {
  it("lo publicado, en palabras, con el aviso, su ficha y «Editar»", () => {
    expect(publishedView(course, false)).toEqual({
      course: COURSE,
      title: "El bosque",
      state: "Publicado",
      tone: "good",
      intro: "Tus alumnos ven esta versión. Para cambiar algo, crea una versión nueva: la revisamos antes de publicarla.",
      blocked: null,
      publicHref: "/cursos/el-bosque",
      summary: "Caminar despacio.",
      modules: [
        { id: "d0000000-0000-4000-8000-000000000001", heading: "Módulo 1: Inicio", lessons: ["Entrar, 20 min 34 s"] },
        { id: "d0000000-0000-4000-8000-000000000002", heading: "Módulo 2", lessons: ["Salir, 45 s"] },
      ],
      open: `open:${COURSE}`,
    });
  });

  it("al suspendido, solo lectura y sin «Editar»", () => {
    expect(publishedView(course, true)).toMatchObject({ open: null, intro: "Estás viendo el curso en solo lectura." });
  });

  it("uno que no se puede copiar (cargado por guion) lo dice de entrada, sin «Editar»", () => {
    expect(publishedView({ ...course, copyable: false }, false)).toMatchObject({
      open: null,
      blocked: "Este curso se cargó directamente y no se puede editar desde aquí. Escríbenos si necesitas cambiarlo.",
    });
  });

  it("uno despublicado, sin «Editar» ni su ficha: volver a publicarlo es de Contenido (T-406)", () => {
    expect(publishedView({ ...course, state: "withdrawn" }, false)).toMatchObject({ state: "Despublicado", tone: "bad", open: null, publicHref: null });
  });

  it("si otra pestaña acaba de abrir la versión, se dice como tal, y «Editar» lleva a ella", () => {
    expect(publishedView({ ...course, state: "changes_pending", pendingVersion: "draft" }, false)).toMatchObject({
      state: "Con cambios pendientes",
      tone: "active",
      open: `open:${COURSE}`,
    });
  });

  it("sin resumen, lo dice", () => {
    expect(publishedView({ ...course, summary: null }, false).summary).toBe("Sin resumen.");
  });
});
