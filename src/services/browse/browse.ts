import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asSystem, asUser } from "@/adapters/supabase/db";

import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import { courseDetailOf, courseStandingOf, type CourseDetail, type CourseLessonRow, type CourseStanding, type MyLessonProgress } from "./course";
import { readCourseLessons, readListedCourses, readListedTeacher, readMyCourseProgress } from "./records";
import { homeShelfOf, newestFirst, teachersOf, type HomeShelf, type ShelfCourse, type ShelfTeacher } from "./shelf";

// El catálogo del alumno (T-210): el inicio (PA-20), la ficha de un curso (PA-02) y la de un
// maestro (PA-03). Lo público es de cualquiera, con sesión o sin ella: se lee como sistema y se
// recuerda treinta segundos, también cuando no se supo, porque esas páginas usan la misma
// reserva de conexiones con la que la gente entra. Lo de cada quien (en qué va de un curso) se
// lee como la persona y no se recuerda.

export type { CourseDetail, CourseStanding } from "./course";
export type { HomeShelf, PracticeRow, ShelfCourse, ShelfTeacher } from "./shelf";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BrowseStore {
  listedCourses(): Promise<ShelfCourse[]>;
  listedTeacher(slug: string): Promise<{ slug: string; name: string; bio: string | null } | null>;
  courseLessons(slug: string): Promise<{ teacher: CourseDetail["teacher"]; lessons: CourseLessonRow[] }>;
  myCourseProgress(claims: VerifiedClaims, slug: string): Promise<MyLessonProgress[]>;
}

export type ShelfAnswer = { kind: "ready"; shelf: HomeShelf } | { kind: "unavailable" };
export type CourseAnswer = { kind: "found"; detail: CourseDetail } | { kind: "not_found" } | { kind: "unavailable" };
export type TeacherAnswer =
  | { kind: "found"; teacher: ShelfTeacher & { bio: string | null }; courses: ShelfCourse[] }
  | { kind: "not_found" }
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

  return { homeShelf, coursePage, teacherPage, courseStanding };
}

export const databaseBrowseStore: BrowseStore = {
  listedCourses: () => asSystem({ reason: "catalog_read" }, (tx) => readListedCourses(tx)),
  listedTeacher: (slug) => asSystem({ reason: "catalog_read" }, (tx) => readListedTeacher(tx, slug)),
  courseLessons: (slug) => asSystem({ reason: "catalog_read" }, (tx) => readCourseLessons(tx, slug)),
  myCourseProgress: (claims, slug) => asUser(claims, (tx) => readMyCourseProgress(tx, slug)),
};

export const { homeShelf, coursePage, teacherPage, courseStanding } = createBrowse({ store: databaseBrowseStore, report: reportFailure });
