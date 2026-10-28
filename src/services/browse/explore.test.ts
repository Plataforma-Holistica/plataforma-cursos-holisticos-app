import { describe, expect, it } from "vitest";

import { asksForResults, cleanQuery, exploreQueryOf, exploreResultsOf, facetsOf, knownQuery, QUERY_MAX_LENGTH, type ExploreQuery } from "./explore";
import type { ShelfCourse } from "./shelf";

// Explorar (PA-21): qué pide la dirección, qué filtros existen y qué cursos los cumplen. La
// búsqueda de la base se simula con los slugs que encontró.

function course(slug: string, over: Partial<ShelfCourse> = {}): ShelfCourse {
  return {
    slug,
    title: `Curso ${slug}`,
    summary: null,
    teacherName: "Ana Robles",
    teacherSlug: "ana-robles",
    practice: { slug: "meditacion", name: "Meditación", tone: 3, position: 2 },
    level: { slug: "principiante", name: "Principiante", position: 1 },
    lessonCount: 1,
    totalSeconds: 60,
    publishedAt: new Date(0),
    isOpen: false,
    ...over,
  };
}

const YOGA = { slug: "yoga", name: "Yoga", tone: 1, position: 1 };
const AVANZADO = { slug: "avanzado", name: "Avanzado", position: 3 };
const COURSES = [
  course("respirar", { publishedAt: new Date(1) }),
  course("posturas", { practice: YOGA, level: AVANZADO, teacherName: "Beto Luna", teacherSlug: "beto-luna", publishedAt: new Date(3) }),
  course("saludo", { practice: YOGA, publishedAt: new Date(2) }),
  course("suelto", { practice: null, level: null, teacherSlug: null, teacherName: "Sin ficha", publishedAt: new Date(4) }),
];
const NOTHING: ExploreQuery = { q: null, practice: null, teacher: null, level: null };

describe("lo que pide la dirección", () => {
  it("lee los cuatro parámetros", () => {
    expect(exploreQueryOf({ q: "respirar", practica: "yoga", maestro: "ana-robles", nivel: "principiante" })).toEqual({
      q: "respirar",
      practice: "yoga",
      teacher: "ana-robles",
      level: "principiante",
    });
  });

  it("un parámetro repetido, o un slug sin forma, no cuenta", () => {
    expect(exploreQueryOf({ q: ["a", "b"], practica: ["yoga", "reiki"], maestro: "Ana Robles", nivel: "../x" })).toEqual(NOTHING);
    expect(exploreQueryOf({ practica: "a".repeat(101) }).practice).toBeNull();
  });

  it("la búsqueda va sin espacios de más ni caracteres de control, y vacía es nula", () => {
    expect(cleanQuery("  yoga   suave\n")).toBe("yoga suave");
    expect(cleanQuery("a\u0000b")).toBe("a b");
    expect(cleanQuery("   ")).toBeNull();
    expect(cleanQuery(null)).toBeNull();
    expect(cleanQuery("x".repeat(500))).toHaveLength(QUERY_MAX_LENGTH);
  });
});

describe("los filtros", () => {
  it("salen de los cursos listados: prácticas y niveles en el orden de PA-67, maestros por nombre", () => {
    expect(facetsOf(COURSES)).toEqual({
      practices: [
        { slug: "yoga", name: "Yoga" },
        { slug: "meditacion", name: "Meditación" },
      ],
      teachers: [
        { slug: "ana-robles", name: "Ana Robles" },
        { slug: "beto-luna", name: "Beto Luna" },
      ],
      levels: [
        { slug: "principiante", name: "Principiante" },
        { slug: "avanzado", name: "Avanzado" },
      ],
    });
  });

  it("uno que no nombra una opción con cursos no se aplica", () => {
    const facets = facetsOf(COURSES);
    expect(knownQuery({ q: "x", practice: "reiki", teacher: "ana-robles", level: "experto" }, facets)).toEqual({
      q: "x",
      practice: null,
      teacher: "ana-robles",
      level: null,
    });
  });

  it("sin filtro ni búsqueda no se piden resultados", () => {
    expect(asksForResults(NOTHING)).toBe(false);
    expect(asksForResults({ ...NOTHING, level: "avanzado" })).toBe(true);
    expect(asksForResults({ ...NOTHING, q: "yoga" })).toBe(true);
  });
});

describe("los resultados", () => {
  const slugs = (query: Partial<ExploreQuery>, matches: Parameters<typeof exploreResultsOf>[2] = null) =>
    exploreResultsOf(COURSES, { ...NOTHING, ...query }, matches).courses.map((each) => each.slug);

  it("cada filtro, los más nuevos primero", () => {
    expect(slugs({ practice: "yoga" })).toEqual(["posturas", "saludo"]);
    expect(slugs({ level: "principiante" })).toEqual(["saludo", "respirar"]);
    expect(slugs({ teacher: "beto-luna" })).toEqual(["posturas"]);
  });

  it("los filtros se combinan", () => {
    expect(slugs({ practice: "yoga", level: "principiante" })).toEqual(["saludo"]);
    expect(slugs({ practice: "meditacion", teacher: "beto-luna" })).toEqual([]);
  });

  it("la búsqueda deja solo lo que encontró la base, y se combina con los filtros", () => {
    const matches = { courses: new Set(["respirar", "posturas"]), teachers: new Set<string>() };
    expect(slugs({ q: "r" }, matches)).toEqual(["posturas", "respirar"]);
    expect(slugs({ q: "r", practice: "yoga" }, matches)).toEqual(["posturas"]);
  });

  it("un maestro que la búsqueda encontró por su nombre sale si tiene algún curso en los resultados", () => {
    const matches = { courses: new Set(["posturas", "saludo"]), teachers: new Set(["beto-luna", "ana-robles"]) };
    const results = exploreResultsOf(COURSES, { ...NOTHING, q: "b", level: "avanzado" }, matches);
    expect(results.courses.map((each) => each.slug)).toEqual(["posturas"]);
    expect(results.teachers.map((each) => each.slug)).toEqual(["beto-luna"]);
  });

  it("sin búsqueda no hay maestros", () => {
    expect(exploreResultsOf(COURSES, { ...NOTHING, practice: "yoga" }, null).teachers).toEqual([]);
  });
});
