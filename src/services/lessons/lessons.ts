import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asSystem, asUser } from "@/adapters/supabase/db";

import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import { lessonPageOf, type LessonPage, type LessonRowData } from "./page";
import { readCourseIsOpen, readCourseLessons, readLessonResources, type LessonResourceRow } from "./records";

// La página de una lección (PA-22, T-203): lo que se pinta alrededor del reproductor. Si la
// cuenta puede ver el video no se decide aquí: lo dice la función única de medios
// (`lessonAccess` al cargar, `getMediaGrant` al reproducir).

export type { LessonEntry, LessonPage } from "./page";
export type { LessonState } from "@/domain/progress/progress";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type LessonPageAnswer = { kind: "found"; page: LessonPage } | { kind: "not_found" } | { kind: "unavailable" };

export interface LessonStore {
  /** Las lecciones vigentes del curso listado, leídas como la persona. */
  courseLessons(claims: VerifiedClaims, slug: string): Promise<LessonRowData[]>;
  /** Si el curso listado es el abierto, o nulo si no existe o no está listado. */
  courseIsOpen(slug: string): Promise<boolean | null>;
  /** Los recursos vigentes de la lección, leídos como la persona (T-404). */
  lessonResources(claims: VerifiedClaims, lessonId: string): Promise<LessonResourceRow[]>;
}

/** Cuánto se recuerda si un curso es abierto: es un dato público, y la página la puede pedir cualquiera. */
export const OPEN_MEMORY_MS = 30_000;
/** Cuántos cursos se recuerdan a la vez: pasado eso, se olvida todo y se empieza de nuevo. */
const OPEN_MEMORY_SIZE = 500;

export function createLessons(deps: { store: LessonStore; report: (code: FailureCode) => Promise<void>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const remembered = new Map<string, { value: boolean | null; at: number }>();

  /**
   * La página de la lección `lessonId` del curso `slug`. `not_found` si el curso no está
   * listado, la lección no está vigente o es de otro curso, o algo no tiene forma: todo eso se
   * ve igual (PA-19). «No se supo» se reporta.
   */
  async function lessonPage(claims: VerifiedClaims, slug: string, lessonId: string): Promise<LessonPageAnswer> {
    if (!SLUG.test(slug) || !ID.test(lessonId)) return { kind: "not_found" };
    let rows: LessonRowData[];
    try {
      rows = await deps.store.courseLessons(claims, slug);
    } catch {
      await deps.report("lesson_page_unavailable");
      return { kind: "unavailable" };
    }
    const page = lessonPageOf(rows, lessonId);
    return page === null ? { kind: "not_found" } : { kind: "found", page };
  }

  /**
   * Si el curso `slug` es el abierto, para quien llega sin sesión: decide si va a registrarse
   * o a entrar. Nulo si no existe, no está listado o no se supo, y la guarda lo trata como «a
   * entrar». No se reporta: es una lectura de cortesía antes de una redirección.
   *
   * Se recuerda treinta segundos por curso, también el nulo y también si no se supo: sin eso,
   * cada visita sin sesión abriría una transacción en la misma reserva de conexiones con la
   * que la gente entra. Es un dato que ya es público (`published_courses.is_open`).
   */
  async function courseIsOpen(slug: string): Promise<boolean | null> {
    if (!SLUG.test(slug)) return null;
    const known = remembered.get(slug);
    if (known !== undefined && now() - known.at < OPEN_MEMORY_MS) return known.value;
    let value: boolean | null;
    try {
      value = await deps.store.courseIsOpen(slug);
    } catch {
      value = null;
    }
    if (remembered.size >= OPEN_MEMORY_SIZE) remembered.clear();
    remembered.set(slug, { value, at: now() });
    return value;
  }

  /**
   * Los recursos de una lección (T-404), para quien ya tiene acceso a ella. Nulo si no se pudieron leer: se reporta, y la
   * pantalla lo dice sin tumbar el video.
   */
  async function lessonResources(claims: VerifiedClaims, lessonId: string): Promise<LessonResourceRow[] | null> {
    if (!ID.test(lessonId)) return [];
    try {
      return await deps.store.lessonResources(claims, lessonId);
    } catch {
      await deps.report("lesson_resources_unavailable");
      return null;
    }
  }

  return { lessonPage, courseIsOpen, lessonResources };
}

/** Las lecturas de verdad: la página como la persona, y lo abierto como sistema (sin sesión no hay persona). */
export const databaseLessonStore: LessonStore = {
  courseLessons: (claims, slug) => asUser(claims, (tx) => readCourseLessons(tx, slug)),
  courseIsOpen: (slug) => asSystem({ reason: "lesson_visitor" }, (tx) => readCourseIsOpen(tx, slug)),
  lessonResources: (claims, lessonId) => asUser(claims, (tx) => readLessonResources(tx, lessonId)),
};

export const { lessonPage, courseIsOpen, lessonResources } = createLessons({ store: databaseLessonStore, report: reportFailure });
