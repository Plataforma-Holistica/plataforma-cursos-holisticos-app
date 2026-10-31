import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asSystem, asUser } from "@/adapters/supabase/db";

import { checkSession, type SessionCheck } from "@/services/account/account";
import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import { courseDetailOf, courseStandingOf, type CourseDetail, type CourseLessonRow, type CourseResourceRow, type CourseStanding, type MyLessonProgress } from "./course";
import { asksForResults, exploreResultsOf, facetsOf, knownQuery, type ExploreFacets, type ExploreQuery, type ExploreResults } from "./explore";
import {
  readCourseLessons,
  readIsSaved,
  readListedCourses,
  readListedTeacher,
  readMyCourseProgress,
  readMySavedCourses,
  removeSavedCourse,
  saveListedCourse,
  searchCatalog,
} from "./records";
import { homeShelfOf, newestFirst, teachersOf, type HomeShelf, type ShelfCourse, type ShelfTeacher } from "./shelf";

// El catálogo del alumno (T-210): el inicio (PA-20), la ficha de un curso (PA-02), la de un
// maestro (PA-03) y explorar (PA-21). Lo público es de cualquiera, con sesión o sin ella: se lee como sistema y se
// recuerda treinta segundos, también cuando no se supo, porque esas páginas usan la misma
// reserva de conexiones con la que la gente entra. Lo de cada quien (en qué va de un curso) se
// lee como la persona y no se recuerda.
//
// Mi lista (RF-311; decisión de Sergio del 2026-10-28): la persona la lee como ella misma, y la
// escribe el servidor, después de la guarda de sesión y a nombre de la sesión que pasó. Ni una
// cuenta llega de fuera: la base escribe a nombre de quien actúa (`private.actor_id()`).

export type { CourseDetail, CourseStanding } from "./course";
export { exploreQueryOf, QUERY_MAX_LENGTH, type ExploreFacets, type ExploreQuery, type ExploreResults, type FacetOption } from "./explore";
export type { HomeShelf, PracticeRow, ShelfCourse, ShelfTeacher } from "./shelf";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BrowseStore {
  listedCourses(): Promise<ShelfCourse[]>;
  listedTeacher(slug: string): Promise<{ slug: string; name: string; bio: string | null } | null>;
  courseLessons(slug: string): Promise<{ teacher: CourseDetail["teacher"]; lessons: CourseLessonRow[]; resources: CourseResourceRow[] }>;
  /** Lo de quien trae esas claims en el curso `slug`, en una lectura: su avance y si está en su lista. */
  myCourse(claims: VerifiedClaims, slug: string): Promise<{ progress: MyLessonProgress[]; saved: boolean }>;
  /** Los slugs de los cursos listados y de los maestros listados que encuentra la búsqueda `q`. */
  search(q: string): Promise<{ courses: string[]; teachers: string[] }>;
  /** Los slugs de la lista de quien trae esas claims, lo último guardado primero. */
  mySavedCourses(claims: VerifiedClaims): Promise<{ slug: string }[]>;
  /** Guarda el curso listado `slug` a nombre de esa sesión. `not_found` si no está listado; ya guardado cuenta como guardado. */
  saveCourse(claims: VerifiedClaims, slug: string): Promise<"saved" | "not_found">;
  /** Quita el curso `slug` de la lista de esa sesión. Si no estaba, no hace nada. */
  removeCourse(claims: VerifiedClaims, slug: string): Promise<void>;
}

export type ShelfAnswer = { kind: "ready"; shelf: HomeShelf } | { kind: "unavailable" };
export type CourseAnswer = { kind: "found"; detail: CourseDetail; resources: CourseResourceRow[] } | { kind: "not_found" } | { kind: "unavailable" };
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
export type StandingAnswer = { kind: "ready"; standing: CourseStanding; saved: boolean } | { kind: "unavailable" };
export type MyListAnswer = { kind: "ready"; courses: ShelfCourse[] } | { kind: "unavailable" };
/** Lo que contesta guardar o quitar. Lo que no pasa la guarda sale tal cual: no se escribió nada. */
export type ListChange =
  | { kind: "saved" }
  | { kind: "removed" }
  /** El slug no tiene forma, o el curso no está listado. */
  | { kind: "not_found" }
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unavailable" };

/** Cuánto se recuerda lo público. Publicar o retirar un curso tarda a lo más esto en verse. */
export const CATALOG_MEMORY_MS = 30_000;
/** Cuántas fichas se recuerdan a la vez: pasado eso, se olvida todo y se empieza de nuevo. */
const MEMORY_SIZE = 500;

type Remembered<T> = { value: T | "unavailable"; at: number };

export function createBrowse(deps: {
  store: BrowseStore;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
  now?: () => number;
}) {
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
    return detail === null ? { kind: "not_found" } : { kind: "found", detail, resources: read.resources };
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
      const mine = await deps.store.myCourse(claims, detail.course.slug);
      return { kind: "ready", standing: courseStandingOf(detail, mine.progress), saved: mine.saved };
    } catch {
      await deps.report("course_progress_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * La lista de quien trae esas claims (las que la guarda le dio a la página): sus cursos que
   * siguen listados, lo último guardado primero. Uno que dejó de estar listado no se pinta, y
   * vuelve si se lista otra vez. La lectura de la persona no ve el registro de cursos: lo
   * listado sale de lo que ya se recuerda, que trae la tarjeta entera. Límite conocido: lo
   * recordado son los `COURSES_READ` más nuevos (`records.ts`), así que con más cursos listados
   * que eso uno guardado y viejo no se pintaría; es el mismo pendiente de las fichas.
   */
  async function myList(claims: VerifiedClaims): Promise<MyListAnswer> {
    const all = await listed();
    if (all === "unavailable") return { kind: "unavailable" };
    let saved: { slug: string }[];
    try {
      saved = await deps.store.mySavedCourses(claims);
    } catch {
      await deps.report("saved_courses_unavailable");
      return { kind: "unavailable" };
    }
    const bySlug = new Map(all.map((course) => [course.slug, course]));
    return { kind: "ready", courses: saved.flatMap(({ slug }) => bySlug.get(slug) ?? []) };
  }

  /** Corre la guarda y escribe a nombre de la sesión que pasó. Un slug sin forma no llega a nadie. */
  async function changeList(reader: CookieReader, slug: string, write: (claims: VerifiedClaims) => Promise<ListChange>): Promise<ListChange> {
    if (slug.length > 100 || !SLUG.test(slug)) return { kind: "not_found" };
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    try {
      return await write(check.claims);
    } catch {
      await deps.report("saved_courses_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** Guarda el curso `slug` en la lista de quien pide (FL-11 paso 6). Dos veces da lo mismo. */
  function saveCourse(reader: CookieReader, slug: string): Promise<ListChange> {
    return changeList(reader, slug, async (claims) =>
      (await deps.store.saveCourse(claims, slug)) === "saved" ? { kind: "saved" } : { kind: "not_found" },
    );
  }

  /** Quita el curso `slug` de la lista de quien pide, esté listado o no. Si no estaba, también es «quitado». */
  function removeCourse(reader: CookieReader, slug: string): Promise<ListChange> {
    return changeList(reader, slug, async (claims) => {
      await deps.store.removeCourse(claims, slug);
      return { kind: "removed" };
    });
  }

  return { homeShelf, coursePage, teacherPage, explore, courseStanding, myList, saveCourse, removeCourse };
}

export const databaseBrowseStore: BrowseStore = {
  listedCourses: () => asSystem({ reason: "catalog_read" }, (tx) => readListedCourses(tx)),
  listedTeacher: (slug) => asSystem({ reason: "catalog_read" }, (tx) => readListedTeacher(tx, slug)),
  courseLessons: (slug) => asSystem({ reason: "catalog_read" }, (tx) => readCourseLessons(tx, slug)),
  myCourse: (claims, slug) =>
    asUser(claims, async (tx) => ({ progress: await readMyCourseProgress(tx, slug), saved: await readIsSaved(tx, slug) })),
  search: (q) => asSystem({ reason: "catalog_read" }, (tx) => searchCatalog(tx, q)),
  mySavedCourses: (claims) => asUser(claims, (tx) => readMySavedCourses(tx)),
  saveCourse: (claims, slug) => asServer({ claims, reason: "save_course" }, (tx) => saveListedCourse(tx, slug)),
  removeCourse: (claims, slug) => asServer({ claims, reason: "remove_course" }, (tx) => removeSavedCourse(tx, slug)),
};

export const { homeShelf, coursePage, teacherPage, explore, courseStanding, myList, saveCourse, removeCourse } = createBrowse({
  store: databaseBrowseStore,
  checkSession,
  report: reportFailure,
});
