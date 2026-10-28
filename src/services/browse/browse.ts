import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asSystem, asUser } from "@/adapters/supabase/db";

import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import { courseDetailOf, courseStandingOf, type CourseDetail, type CourseLessonRow, type CourseStanding, type MyLessonProgress } from "./course";
import { asksForResults, exploreResultsOf, facetsOf, knownQuery, type ExploreFacets, type ExploreQuery, type ExploreResults } from "./explore";
import { readCourseLessons, readListedCourses, readListedTeacher, readMyCourseProgress, searchCatalog } from "./records";
import { homeShelfOf, newestFirst, teachersOf, type HomeShelf, type ShelfCourse, type ShelfTeacher } from "./shelf";

// El catálogo del alumno (T-210): el inicio (PA-20), la ficha de un curso (PA-02), la de un
// maestro (PA-03) y explorar (PA-21). Lo público es de cualquiera, con sesión o sin ella: se lee como sistema y se
// recuerda treinta segundos, también cuando no se supo, porque esas páginas usan la misma
// reserva de conexiones con la que la gente entra. Lo de cada quien (en qué va de un curso) se
// lee como la persona y no se recuerda.

export type { CourseDetail, CourseStanding } from "./course";
export { exploreQueryOf, QUERY_MAX_LENGTH, type ExploreFacets, type ExploreQuery, type ExploreResults, type FacetOption } from "./explore";
export type { HomeShelf, PracticeRow, ShelfCourse, ShelfTeacher } from "./shelf";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BrowseStore {
  listedCourses(): Promise<ShelfCourse[]>;
  listedTeacher(slug: string): Promise<{ slug: string; name: string; bio: string | null } | null>;
  courseLessons(slug: string): Promise<{ teacher: CourseDetail["teacher"]; lessons: CourseLessonRow[] }>;
  myCourseProgress(claims: VerifiedClaims, slug: string): Promise<MyLessonProgress[]>;
  /** Los slugs de los cursos listados y de los maestros listados que encuentra la búsqueda `q`. */
  search(q: string): Promise<{ courses: string[]; teachers: string[] }>;
}

export type ShelfAnswer = { kind: "ready"; shelf: HomeShelf } | { kind: "unavailable" };
export type CourseAnswer = { kind: "found"; detail: CourseDetail } | { kind: "not_found" } | { kind: "unavailable" };
export type TeacherAnswer =
  | { kind: "found"; teacher: ShelfTeacher & { bio: string | null }; courses: ShelfCourse[] }
  | { kind: "not_found" }
  | { kind: "unavailable" };
export type ExploreAnswer =
  | {
      kind: "ready";
      /** Lo pedido, sin los filtros que no nombran una opción con cursos. */
      query: ExploreQuery;
      facets: ExploreFacets;
      /** Nulo sin filtro ni búsqueda: entonces se pinta un carrusel por práctica (`shelf`). */
      results: ExploreResults | null;
      shelf: HomeShelf;
    }
  | { kind: "unavailable" };
export type StandingAnswer = { kind: "ready"; standing: CourseStanding } | { kind: "unavailable" };

/** Cuánto se recuerda lo público. Publicar o retirar un curso tarda a lo más esto en verse. */
export const CATALOG_MEMORY_MS = 30_000;
/** Cuántas fichas se recuerdan a la vez: pasado eso, se olvida todo y se empieza de nuevo. */
const MEMORY_SIZE = 500;

type Remembered<T> = { value: T | "unavailable"; at: number };

export function createBrowse(deps: { store: BrowseStore; report: (code: FailureCode) => Promise<void>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let courses: Remembered<ShelfCourse[]> | null = null;
  const lessons = new Map<string, Remembered<Awaited<ReturnType<BrowseStore["courseLessons"]>>>>();
  const teachers = new Map<string, Remembered<Awaited<ReturnType<BrowseStore["listedTeacher"]>>>>();
  const searches = new Map<string, Remembered<Awaited<ReturnType<BrowseStore["search"]>>>>();

  const fresh = (memory: { at: number } | null | undefined) => memory != null && now() - memory.at < CATALOG_MEMORY_MS;

  async function attempt<T>(read: () => Promise<T>): Promise<T | "unavailable"> {
    try {
      return await read();
    } catch {
      await deps.report("catalog_unavailable");
      return "unavailable";
    }
  }

  async function remembered<T>(memory: Map<string, Remembered<T>>, key: string, read: () => Promise<T>): Promise<T | "unavailable"> {
    const known = memory.get(key);
    if (fresh(known)) return (known as Remembered<T>).value;
    const value = await attempt(read);
    if (memory.size >= MEMORY_SIZE && !memory.has(key)) memory.clear();
    memory.set(key, { value, at: now() });
    return value;
  }

  async function listed(): Promise<ShelfCourse[] | "unavailable"> {
    if (fresh(courses)) return (courses as Remembered<ShelfCourse[]>).value;
    const value = await attempt(() => deps.store.listedCourses());
    courses = { value, at: now() };
    return value;
  }

  /** Las filas del inicio (PA-20). «No se supo» se reporta una vez por lectura. */
  async function homeShelf(): Promise<ShelfAnswer> {
    const all = await listed();
    return all === "unavailable" ? { kind: "unavailable" } : { kind: "ready", shelf: homeShelfOf(all) };
  }

  /** La ficha del curso `slug` (PA-02). `not_found` si no está listado, no tiene lecciones vigentes o el slug no tiene forma. */
  async function coursePage(slug: string): Promise<CourseAnswer> {
    if (!SLUG.test(slug)) return { kind: "not_found" };
    const all = await listed();
    if (all === "unavailable") return { kind: "unavailable" };
    const course = all.find((each) => each.slug === slug);
    if (course === undefined) return { kind: "not_found" };
    const read = await remembered(lessons, slug, () => deps.store.courseLessons(slug));
    if (read === "unavailable") return { kind: "unavailable" };
    const detail = courseDetailOf(course, read.teacher, read.lessons);
    return detail === null ? { kind: "not_found" } : { kind: "found", detail };
  }

  /** La ficha del maestro `slug` (PA-03). `not_found` si no está listado o no tiene cursos listados: se ve igual (PA-19). */
  async function teacherPage(slug: string): Promise<TeacherAnswer> {
    if (!SLUG.test(slug)) return { kind: "not_found" };
    // Primero lo listado, que ya se recuerda: un slug que no es de nadie no llega a la base, y no
    // desplaza de la memoria a los que sí existen.
    const all = await listed();
    if (all === "unavailable") return { kind: "unavailable" };
    const theirs = all.filter((course) => course.teacherSlug === slug).sort(newestFirst);
    const [summary] = teachersOf(theirs);
    if (summary === undefined) return { kind: "not_found" };
    const teacher = await remembered(teachers, slug, () => deps.store.listedTeacher(slug));
    if (teacher === "unavailable") return { kind: "unavailable" };
    if (teacher === null) return { kind: "not_found" };
    return { kind: "found", teacher: { ...summary, name: teacher.name, bio: teacher.bio }, courses: theirs };
  }

  /**
   * Explorar (PA-21): los filtros y, si se pide algo, los resultados. Los cursos son los listados
   * que ya se recuerdan; la búsqueda se le pregunta a la base y se recuerda igual, por texto.
   */
  async function explore(asked: ExploreQuery): Promise<ExploreAnswer> {
    const all = await listed();
    if (all === "unavailable") return { kind: "unavailable" };
    const facets = facetsOf(all);
    const query = knownQuery(asked, facets);
    const shelf = homeShelfOf(all);
    if (!asksForResults(query)) return { kind: "ready", query, facets, results: null, shelf };
    let matches: { courses: Set<string>; teachers: Set<string> } | null = null;
    if (query.q !== null) {
      const q = query.q;
      const found = await remembered(searches, q, () => deps.store.search(q));
      if (found === "unavailable") return { kind: "unavailable" };
      matches = { courses: new Set(found.courses), teachers: new Set(found.teachers) };
    }
    return { kind: "ready", query, facets, results: exploreResultsOf(all, query, matches), shelf };
  }

  /**
   * En qué va quien trae esas claims (las que la guarda le dio a la página) en el curso de esa
   * ficha. «No se supo» se reporta, y la ficha se pinta sin el avance.
   */
  async function courseStanding(claims: VerifiedClaims, detail: CourseDetail): Promise<StandingAnswer> {
    try {
      return { kind: "ready", standing: courseStandingOf(detail, await deps.store.myCourseProgress(claims, detail.course.slug)) };
    } catch {
      await deps.report("course_progress_unavailable");
      return { kind: "unavailable" };
    }
  }

  return { homeShelf, coursePage, teacherPage, explore, courseStanding };
}

export const databaseBrowseStore: BrowseStore = {
  listedCourses: () => asSystem({ reason: "catalog_read" }, (tx) => readListedCourses(tx)),
  listedTeacher: (slug) => asSystem({ reason: "catalog_read" }, (tx) => readListedTeacher(tx, slug)),
  courseLessons: (slug) => asSystem({ reason: "catalog_read" }, (tx) => readCourseLessons(tx, slug)),
  myCourseProgress: (claims, slug) => asUser(claims, (tx) => readMyCourseProgress(tx, slug)),
  search: (q) => asSystem({ reason: "catalog_read" }, (tx) => searchCatalog(tx, q)),
};

export const { homeShelf, coursePage, teacherPage, explore, courseStanding } = createBrowse({ store: databaseBrowseStore, report: reportFailure });
