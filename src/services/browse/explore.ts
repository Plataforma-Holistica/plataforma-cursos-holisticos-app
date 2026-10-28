// Explorar y buscar (PA-21; RF-304; FL-11; T-210, segunda solicitud), armado con los cursos
// listados que ya se leyeron para el inicio. Es puro: lo que encontró la búsqueda (qué cursos
// y qué maestros) lo trae quien llama, que se lo preguntó a la base.
//
// Los filtros y la búsqueda viven en la dirección (`?practica=`, `?maestro=`, `?nivel=`, `?q=`).
// Un filtro que no nombra una práctica, un maestro o un nivel con cursos listados no se aplica
// ni se pinta (decisión mía sin confirmar, 2026-10-28): una dirección vieja no deja un filtro
// invisible que vacíe los resultados.

import { newestFirst, teachersOf, type ShelfCourse, type ShelfTeacher } from "./shelf";

/** Lo que pide la dirección, ya revisado: un slug con forma o nulo, y la búsqueda limpia o nula. */
export interface ExploreQuery {
  q: string | null;
  practice: string | null;
  teacher: string | null;
  level: string | null;
}

export interface FacetOption {
  slug: string;
  name: string;
}

/** Las opciones de cada filtro: solo las que tienen cursos listados. */
export interface ExploreFacets {
  /** En el orden de PA-67. */
  practices: FacetOption[];
  /** Por nombre. */
  teachers: FacetOption[];
  /** En el orden de PA-67. */
  levels: FacetOption[];
}

/** Lo que encontró la búsqueda en la base, por slug. */
export interface SearchMatches {
  courses: ReadonlySet<string>;
  teachers: ReadonlySet<string>;
}

export interface ExploreResults {
  courses: ShelfCourse[];
  /** Los maestros cuyo nombre coincide con la búsqueda y que tienen algún curso en los resultados. */
  teachers: ShelfTeacher[];
}

/** El largo máximo de la búsqueda: la base mira los primeros 100 caracteres. */
export const QUERY_MAX_LENGTH = 100;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Un parámetro de la dirección: solo si viene una vez, como texto. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function slugOf(value: string | string[] | undefined): string | null {
  const text = single(value);
  return text !== null && text.length <= 100 && SLUG.test(text) ? text : null;
}

/** La búsqueda sin espacios de más (también los duros) ni caracteres de control, recortada; vacía es nula. */
export function cleanQuery(value: string | null): string | null {
  if (value === null) return null;
  const clean = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\s   ]+/gu, " ")
    .trim()
    .slice(0, QUERY_MAX_LENGTH)
    .trim();
  return clean === "" ? null : clean;
}

/** Lo que pide la dirección (`searchParams` de la página), revisado. */
export function exploreQueryOf(params: Record<string, string | string[] | undefined>): ExploreQuery {
  return {
    q: cleanQuery(single(params.q)),
    practice: slugOf(params.practica),
    teacher: slugOf(params.maestro),
    level: slugOf(params.nivel),
  };
}

/** Las opciones de los filtros, sacadas de los cursos listados. */
export function facetsOf(courses: readonly ShelfCourse[]): ExploreFacets {
  const practices = new Map<string, FacetOption & { position: number }>();
  const levels = new Map<string, FacetOption & { position: number }>();
  for (const course of courses) {
    if (course.practice !== null) practices.set(course.practice.slug, { slug: course.practice.slug, name: course.practice.name, position: course.practice.position });
    if (course.level !== null) levels.set(course.level.slug, { slug: course.level.slug, name: course.level.name, position: course.level.position });
  }
  const ordered = (found: Map<string, FacetOption & { position: number }>) =>
    [...found.values()].sort((a, b) => a.position - b.position).map(({ slug, name }) => ({ slug, name }));
  return {
    practices: ordered(practices),
    teachers: teachersOf(courses).map(({ slug, name }) => ({ slug, name })),
    levels: ordered(levels),
  };
}

/** Lo pedido, sin los filtros que no nombran una opción de verdad. */
export function knownQuery(query: ExploreQuery, facets: ExploreFacets): ExploreQuery {
  const known = (slug: string | null, options: FacetOption[]) => (slug !== null && options.some((option) => option.slug === slug) ? slug : null);
  return {
    q: query.q,
    practice: known(query.practice, facets.practices),
    teacher: known(query.teacher, facets.teachers),
    level: known(query.level, facets.levels),
  };
}

/** Si se pide algo: sin filtro ni búsqueda, la pantalla pinta un carrusel por práctica. */
export function asksForResults(query: ExploreQuery): boolean {
  return query.q !== null || query.practice !== null || query.teacher !== null || query.level !== null;
}

/**
 * Los cursos que cumplen todo lo pedido, los más nuevos primero, y los maestros que la
 * búsqueda encontró por su nombre. `matches` es nulo sin búsqueda. Los filtros ya son conocidos.
 */
export function exploreResultsOf(courses: readonly ShelfCourse[], query: ExploreQuery, matches: SearchMatches | null): ExploreResults {
  const found = courses
    .filter(
      (course) =>
        (query.practice === null || course.practice?.slug === query.practice) &&
        (query.level === null || course.level?.slug === query.level) &&
        (query.teacher === null || course.teacherSlug === query.teacher) &&
        (matches === null || matches.courses.has(course.slug)),
    )
    .sort(newestFirst);
  return {
    courses: found,
    teachers: matches === null ? [] : teachersOf(found).filter((teacher) => matches.teachers.has(teacher.slug)),
  };
}
