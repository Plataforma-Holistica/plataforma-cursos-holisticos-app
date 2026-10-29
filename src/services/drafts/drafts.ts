import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { parseDraftText, type DraftTextKind } from "@/domain/catalog/draft-text";

import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

// El borrador de un curso (RF-603, FL-32; PA-42 y PA-43; T-402). Lo escribe solo el maestro activo:
// lo decide la base, con `private.current_active_teacher_id()` en cada función del borrador. Aquí se
// decide a quién se le pregunta qué y en qué orden, como en las listas del catálogo:
//
//   · Lo que llega se revisa antes que nada: ids con forma, posiciones y revisiones enteras, textos
//     con la regla del dominio. Lo que no la tiene no llega a nadie (`invalid`).
//   · La guarda de sesión va después, siempre; lo que no sea «pasa» se contesta tal cual.
//   · Nada de lo que llega dice quién actúa: sale de la sesión que pasó la guarda. La base pone al
//     maestro.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra la lista cerrada de
//     su función. Otra cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.
//
// Leer va como la persona (`asUser`): su maestro lee lo suyo, también suspendido.

export const COURSE_STATES = ["draft", "in_review", "published", "changes_pending", "withdrawn"] as const;
export type CourseState = (typeof COURSE_STATES)[number];

/** Un curso de quien pide, para PA-42. El título es el del borrador, o el publicado si no hay borrador. */
export interface TeacherCourse {
  id: string;
  state: CourseState;
  title: string;
  /** Lo último guardado en su borrador, o el último cambio del registro. */
  updatedAt: string;
  hasDraft: boolean;
}

export interface DraftLesson {
  id: string;
  title: string;
  description: string | null;
  position: number;
  revision: number;
}
export interface DraftModule {
  id: string;
  title: string;
  position: number;
  revision: number;
  lessons: DraftLesson[];
}
export interface DraftCourse {
  id: string;
  state: CourseState;
  version: number;
  title: string;
  summary: string | null;
  practiceId: string | null;
  levelId: string | null;
  revision: number;
  structureRevision: number;
  updatedAt: string;
  modules: DraftModule[];
}

/** Lo que contesta cada función de la base. */
const REFUSALS = ["suspended", "not_teacher"] as const;
const OPEN = ["not_found", "not_editable", ...REFUSALS] as const;
export const CREATE_ANSWERS = ["created", "invalid", ...REFUSALS] as const;
export const SAVE_COURSE_ANSWERS = ["saved", "changed", "invalid", "practice_inactive", "level_inactive", ...OPEN] as const;
export const ADD_ANSWERS = ["created", "changed", "invalid", ...OPEN] as const;
export const SAVE_ANSWERS = ["saved", "changed", "invalid", ...OPEN] as const;
export const MOVE_ANSWERS = ["moved", "changed", "invalid", ...OPEN] as const;
export const DELETE_ANSWERS = ["deleted", "changed", ...OPEN] as const;
export type CreateAnswer = (typeof CREATE_ANSWERS)[number];
export type SaveCourseAnswer = (typeof SAVE_COURSE_ANSWERS)[number];
export type AddAnswer = (typeof ADD_ANSWERS)[number];
export type SaveAnswer = (typeof SAVE_ANSWERS)[number];
export type MoveAnswer = (typeof MOVE_ANSWERS)[number];
export type DeleteAnswer = (typeof DELETE_ANSWERS)[number];

/** Lo que contestó crear o agregar: el id de lo nuevo, solo con `created`. */
export interface Created<Answer extends string> {
  answer: Answer;
  id: string | null;
}

export interface CourseFields {
  title: string;
  summary: string | null;
  practiceId: string | null;
  levelId: string | null;
}

/** Lo que el servicio le pregunta a la base (`store.ts`). */
export interface DraftsStore {
  teacherCourses: (claims: VerifiedClaims) => Promise<TeacherCourse[]>;
  draftCourse: (claims: VerifiedClaims, course: string) => Promise<DraftCourse | null>;
  create: (claims: VerifiedClaims, title: string) => Promise<Created<CreateAnswer>>;
  saveCourse: (claims: VerifiedClaims, course: string, seen: number, fields: CourseFields) => Promise<SaveCourseAnswer>;
  addModule: (claims: VerifiedClaims, course: string, seen: number, title: string) => Promise<Created<AddAnswer>>;
  renameModule: (claims: VerifiedClaims, course: string, module: string, seen: number, title: string) => Promise<SaveAnswer>;
  deleteModule: (claims: VerifiedClaims, course: string, module: string, seen: number) => Promise<DeleteAnswer>;
  moveModule: (claims: VerifiedClaims, course: string, module: string, seenPosition: number, toPosition: number) => Promise<MoveAnswer>;
  addLesson: (claims: VerifiedClaims, course: string, module: string, seen: number, title: string) => Promise<Created<AddAnswer>>;
  saveLesson: (
    claims: VerifiedClaims,
    course: string,
    lesson: string,
    seen: number,
    fields: { title: string; description: string | null },
  ) => Promise<SaveAnswer>;
  deleteLesson: (claims: VerifiedClaims, course: string, lesson: string, seen: number) => Promise<DeleteAnswer>;
  moveLesson: (
    claims: VerifiedClaims,
    course: string,
    lesson: string,
    seen: { module: string; position: number },
    to: { module: string; position: number },
  ) => Promise<MoveAnswer>;
  deleteCourse: (claims: VerifiedClaims, course: string, seen: number) => Promise<DeleteAnswer>;
}

export interface DraftsDeps {
  store: DraftsStore;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
}

/** Lo que contesta una lectura. */
export type DraftRead<Value> = { kind: "ready"; value: Value } | { kind: "unavailable" };
/**
 * Lo que contesta un cambio: la respuesta de la base (crear y agregar traen el id de lo nuevo con
 * `created`), la guarda que no dejó pasar, o «no se supo».
 */
export type DraftChange<Answer extends string> =
  | { kind: Answer; id?: string | null }
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unknown" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Una revisión o una posición: entero positivo que cabe sin perder precisión. */
const isCount = (value: number) => Number.isSafeInteger(value) && value >= 1;
const isId = (value: string) => ID.test(value);

/** El texto ya revisado, o nulo si no tiene forma. Un texto obligatorio vacío tampoco la tiene. */
function textOf(kind: DraftTextKind, input: string | null): { text: string | null } | null {
  const parsed = parseDraftText(kind, input);
  return parsed.ok ? { text: parsed.text } : null;
}

export function createDrafts(deps: DraftsDeps) {
  /** Una lectura como la persona, con las claims que la guarda le dio a la página. */
  async function read<Value>(work: () => Promise<Value>): Promise<DraftRead<Value>> {
    try {
      return { kind: "ready", value: await work() };
    } catch {
      await deps.report("draft_read_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** Los cursos de quien trae esas claims, lo último guardado primero. */
  function teacherCourses(claims: VerifiedClaims): Promise<DraftRead<TeacherCourse[]>> {
    return read(() => deps.store.teacherCourses(claims));
  }

  /** El borrador del curso `course` de quien trae esas claims, o nulo si para esa persona no existe. */
  function draftCourse(claims: VerifiedClaims, course: string): Promise<DraftRead<DraftCourse | null>> {
    if (!isId(course)) return Promise.resolve({ kind: "ready", value: null });
    return read(() => deps.store.draftCourse(claims, course));
  }

  /**
   * Corre la guarda y escribe a nombre de la sesión que pasó. Lo que no tiene forma se contesta
   * `invalid` antes, sin preguntarle a nadie.
   */
  async function change<Answer extends string>(
    reader: CookieReader,
    wellFormed: boolean,
    write: (claims: VerifiedClaims) => Promise<{ kind: Answer; id?: string | null }>,
  ): Promise<DraftChange<Answer | "invalid">> {
    if (!wellFormed) return { kind: "invalid" };
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    try {
      return await write(check.claims);
    } catch {
      await deps.report("draft_change_unavailable");
      return { kind: "unknown" };
    }
  }

  function createCourse(reader: CookieReader, title: string | null) {
    const parsed = textOf("courseTitle", title);
    return change<CreateAnswer>(reader, parsed !== null, async (claims) => {
      const created = await deps.store.create(claims, parsed?.text ?? "");
      return created.answer === "created" ? { kind: created.answer, id: created.id } : { kind: created.answer };
    });
  }

  function saveCourse(
    reader: CookieReader,
    input: { course: string; seen: number; title: string | null; summary: string | null; practiceId: string | null; levelId: string | null },
  ) {
    const title = textOf("courseTitle", input.title);
    const summary = textOf("summary", input.summary);
    const formed =
      isId(input.course) &&
      isCount(input.seen) &&
      title !== null &&
      summary !== null &&
      (input.practiceId === null || isId(input.practiceId)) &&
      (input.levelId === null || isId(input.levelId));
    return change<SaveCourseAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.saveCourse(claims, input.course, input.seen, {
        title: title?.text ?? "",
        summary: summary?.text ?? null,
        practiceId: input.practiceId,
        levelId: input.levelId,
      }),
    }));
  }

  function addModule(reader: CookieReader, input: { course: string; seen: number; title: string | null }) {
    const title = textOf("moduleTitle", input.title);
    const formed = isId(input.course) && isCount(input.seen) && title !== null;
    return change<AddAnswer>(reader, formed, async (claims) => {
      const created = await deps.store.addModule(claims, input.course, input.seen, title?.text ?? "");
      return created.answer === "created" ? { kind: created.answer, id: created.id } : { kind: created.answer };
    });
  }

  function renameModule(reader: CookieReader, input: { course: string; module: string; seen: number; title: string | null }) {
    const title = textOf("moduleTitle", input.title);
    const formed = isId(input.course) && isId(input.module) && isCount(input.seen) && title !== null;
    return change<SaveAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.renameModule(claims, input.course, input.module, input.seen, title?.text ?? ""),
    }));
  }

  function deleteModule(reader: CookieReader, input: { course: string; module: string; seen: number }) {
    const formed = isId(input.course) && isId(input.module) && isCount(input.seen);
    return change<DeleteAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.deleteModule(claims, input.course, input.module, input.seen),
    }));
  }

  function moveModule(reader: CookieReader, input: { course: string; module: string; seenPosition: number; toPosition: number }) {
    const formed = isId(input.course) && isId(input.module) && isCount(input.seenPosition) && isCount(input.toPosition);
    return change<MoveAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.moveModule(claims, input.course, input.module, input.seenPosition, input.toPosition),
    }));
  }

  function addLesson(reader: CookieReader, input: { course: string; module: string; seen: number; title: string | null }) {
    const title = textOf("lessonTitle", input.title);
    const formed = isId(input.course) && isId(input.module) && isCount(input.seen) && title !== null;
    return change<AddAnswer>(reader, formed, async (claims) => {
      const created = await deps.store.addLesson(claims, input.course, input.module, input.seen, title?.text ?? "");
      return created.answer === "created" ? { kind: created.answer, id: created.id } : { kind: created.answer };
    });
  }

  function saveLesson(
    reader: CookieReader,
    input: { course: string; lesson: string; seen: number; title: string | null; description: string | null },
  ) {
    const title = textOf("lessonTitle", input.title);
    const description = textOf("description", input.description);
    const formed = isId(input.course) && isId(input.lesson) && isCount(input.seen) && title !== null && description !== null;
    return change<SaveAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.saveLesson(claims, input.course, input.lesson, input.seen, {
        title: title?.text ?? "",
        description: description?.text ?? null,
      }),
    }));
  }

  function deleteLesson(reader: CookieReader, input: { course: string; lesson: string; seen: number }) {
    const formed = isId(input.course) && isId(input.lesson) && isCount(input.seen);
    return change<DeleteAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.deleteLesson(claims, input.course, input.lesson, input.seen),
    }));
  }

  function moveLesson(
    reader: CookieReader,
    input: { course: string; lesson: string; seen: { module: string; position: number }; to: { module: string; position: number } },
  ) {
    const formed =
      isId(input.course) &&
      isId(input.lesson) &&
      isId(input.seen.module) &&
      isCount(input.seen.position) &&
      isId(input.to.module) &&
      isCount(input.to.position);
    return change<MoveAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.moveLesson(claims, input.course, input.lesson, input.seen, input.to),
    }));
  }

  /** Borra un borrador que nunca se envió (decisión de Sergio del 2026-10-29), con todo lo suyo. */
  function deleteCourse(reader: CookieReader, input: { course: string; seen: number }) {
    const formed = isId(input.course) && isCount(input.seen);
    return change<DeleteAnswer>(reader, formed, async (claims) => ({
      kind: await deps.store.deleteCourse(claims, input.course, input.seen),
    }));
  }

  return {
    teacherCourses,
    draftCourse,
    createCourse,
    saveCourse,
    addModule,
    renameModule,
    deleteModule,
    moveModule,
    addLesson,
    saveLesson,
    deleteLesson,
    moveLesson,
    deleteCourse,
  };
}
