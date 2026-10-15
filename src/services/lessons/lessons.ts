import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asSystem, asUser } from "@/adapters/supabase/db";

import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import { lessonPageOf, type LessonPage, type LessonRowData } from "./page";
import { readCourseIsOpen, readCourseLessons } from "./records";

// La página de una lección (PA-22, T-203): lo que se pinta alrededor del reproductor. Si la
// cuenta puede ver el video no se decide aquí: lo dice la función única de medios
// (`lessonAccess` al cargar, `getMediaGrant` al reproducir).

export type { LessonEntry, LessonPage } from "./page";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type LessonPageAnswer = { kind: "found"; page: LessonPage } | { kind: "not_found" } | { kind: "unavailable" };

export interface LessonStore {
  /** Las lecciones vigentes del curso listado, leídas como la persona. */
  courseLessons(claims: VerifiedClaims, slug: string): Promise<LessonRowData[]>;
  /** Si el curso listado es el abierto, o nulo si no existe o no está listado. */
  courseIsOpen(slug: string): Promise<boolean | null>;
}

export function createLessons(deps: { store: LessonStore; report: (code: FailureCode) => Promise<void> }) {
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
   */
  async function courseIsOpen(slug: string): Promise<boolean | null> {
    if (!SLUG.test(slug)) return null;
    try {
      return await deps.store.courseIsOpen(slug);
    } catch {
      return null;
    }
  }

  return { lessonPage, courseIsOpen };
}

/** Las lecturas de verdad: la página como la persona, y lo abierto como sistema (sin sesión no hay persona). */
export const databaseLessonStore: LessonStore = {
  courseLessons: (claims, slug) => asUser(claims, (tx) => readCourseLessons(tx, slug)),
  courseIsOpen: (slug) => asSystem({ reason: "lesson_visitor" }, (tx) => readCourseIsOpen(tx, slug)),
};

export const { lessonPage, courseIsOpen } = createLessons({ store: databaseLessonStore, report: reportFailure });
