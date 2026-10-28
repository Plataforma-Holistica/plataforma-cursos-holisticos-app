import { describe, expect, it } from "vitest";

import { homeShelfOf, ROW_LIMIT, teachersOf, type ShelfCourse } from "./shelf";

const MEDITATION = { slug: "meditacion", name: "Meditación", tone: 3, position: 2 };
const YOGA = { slug: "yoga", name: "Yoga", tone: 5, position: 1 };
const BEGINNER = { slug: "principiante", name: "Principiante", position: 1 };
const ADVANCED = { slug: "avanzado", name: "Avanzado", position: 3 };

function course(slug: string, day: number, extra: Partial<ShelfCourse> = {}): ShelfCourse {
  return {
    slug,
    title: `Curso ${slug}`,
    summary: null,
    teacherName: "Ana Robles",
    teacherSlug: "ana-robles",
    practice: MEDITATION,
    level: BEGINNER,
    lessonCount: 3,
    totalSeconds: 900,
    publishedAt: new Date(Date.UTC(2026, 9, day)),
    isOpen: false,
    ...extra,
  };
}

describe("homeShelfOf", () => {
  it("sin cursos, todas las filas van vacías", () => {
    expect(homeShelfOf([])).toEqual({ starters: [], newest: [], practices: [], teachers: [] });
  });

  it("«Nuevos» va del más nuevo al más viejo, y en un empate por slug", () => {
    const shelf = homeShelfOf([course("b", 1), course("c", 3), course("a", 1)]);
    expect(shelf.newest.map((each) => each.slug)).toEqual(["c", "a", "b"]);
  });

  it("«Para empezar» son los del primer nivel que tenga cursos, los más nuevos primero", () => {
    const shelf = homeShelfOf([course("viejo", 1), course("avanzado", 5, { level: ADVANCED }), course("nuevo", 4)]);
    expect(shelf.starters.map((each) => each.slug)).toEqual(["nuevo", "viejo"]);
  });

  it("si nadie es del primer nivel del orden, «Para empezar» toma el más bajo que haya", () => {
    const shelf = homeShelfOf([course("a", 1, { level: ADVANCED }), course("b", 2, { level: null })]);
    expect(shelf.starters.map((each) => each.slug)).toEqual(["a"]);
  });

  it("sin niveles, no hay «Para empezar»", () => {
    expect(homeShelfOf([course("a", 1, { level: null })]).starters).toEqual([]);
  });

  it("una fila por práctica con cursos, en el orden de PA-67, y ninguna para un curso sin práctica", () => {
    const shelf = homeShelfOf([course("m", 1), course("y", 2, { practice: YOGA }), course("sin", 3, { practice: null })]);
    expect(shelf.practices.map((row) => [row.slug, row.name, row.tone, row.courses.map((each) => each.slug)])).toEqual([
      ["yoga", "Yoga", 5, ["y"]],
      ["meditacion", "Meditación", 3, ["m"]],
    ]);
  });

  it("ninguna fila pasa del tope", () => {
    const many = Array.from({ length: ROW_LIMIT + 3 }, (_, index) => course(`c${String(index).padStart(2, "0")}`, index + 1));
    const shelf = homeShelfOf(many);
    expect(shelf.newest).toHaveLength(ROW_LIMIT);
    expect(shelf.starters).toHaveLength(ROW_LIMIT);
    expect(shelf.practices[0]?.courses).toHaveLength(ROW_LIMIT);
    // El tope se queda con los más nuevos.
    expect(shelf.newest[0]?.slug).toBe(`c${ROW_LIMIT + 2}`);
  });
});

describe("teachersOf", () => {
  it("junta los cursos de cada maestro, con sus prácticas sin repetir y en el orden de PA-67", () => {
    const teachers = teachersOf([
      course("a", 1),
      course("b", 2, { practice: YOGA }),
      course("c", 3),
      course("d", 4, { teacherName: "Beto Luna", teacherSlug: "beto-luna", practice: null }),
    ]);
    expect(teachers).toEqual([
      { slug: "ana-robles", name: "Ana Robles", practices: ["Yoga", "Meditación"], courseCount: 3 },
      { slug: "beto-luna", name: "Beto Luna", practices: [], courseCount: 1 },
    ]);
  });

  it("deja fuera los cursos de un maestro que no está listado", () => {
    expect(teachersOf([course("a", 1, { teacherSlug: null })])).toEqual([]);
  });

  it("ordena por nombre en español", () => {
    const teachers = teachersOf([
      course("a", 1, { teacherName: "Óscar", teacherSlug: "oscar" }),
      course("b", 1, { teacherName: "Pablo", teacherSlug: "pablo" }),
      course("c", 1, { teacherName: "Natalia", teacherSlug: "natalia" }),
    ]);
    expect(teachers.map((each) => each.slug)).toEqual(["natalia", "oscar", "pablo"]);
  });
});
