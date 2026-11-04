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
  modules: [
    { id: "d0000000-0000-4000-8000-000000000001", title: "Inicio", lessons: [{ id: "e0000000-0000-4000-8000-000000000001", title: "Entrar", seconds: 1234 }] },
    { id: "d0000000-0000-4000-8000-000000000002", title: "", lessons: [{ id: "e0000000-0000-4000-8000-000000000002", title: "Salir", seconds: 45 }] },
  ],
};

describe("publishedView", () => {
  it("lo publicado, en palabras, con el aviso y «Editar»", () => {
    expect(publishedView(course, false)).toEqual({
      course: COURSE,
      title: "El bosque",
      state: "Publicado",
      tone: "good",
      intro: "Tus alumnos ven esta versión. Para cambiar algo, crea una versión nueva: la revisamos antes de publicarla.",
      summary: "Caminar despacio.",
      modules: [
        { id: "d0000000-0000-4000-8000-000000000001", heading: "Módulo 1: Inicio", lessons: ["Entrar, 20 min 34 s"] },
        { id: "d0000000-0000-4000-8000-000000000002", heading: "Módulo 2", lessons: ["Salir, 45 s"] },
      ],
      open: `open:${COURSE}`,
    });
  });

  it("al suspendido, sin «Editar»", () => {
    expect(publishedView(course, true).open).toBeNull();
  });

  it("uno retirado, sin «Editar»: retirar es de Contenido (T-406)", () => {
    expect(publishedView({ ...course, state: "withdrawn" }, false)).toMatchObject({ state: "Despublicado", open: null });
  });

  it("sin resumen, lo dice", () => {
    expect(publishedView({ ...course, summary: null }, false).summary).toBe("Sin resumen.");
  });
});
