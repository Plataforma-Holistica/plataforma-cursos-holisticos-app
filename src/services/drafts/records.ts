import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { COURSE_STATES, type CourseFields, type DraftCourse, type TeacherCourse } from "./drafts";

// Lo que el servicio del borrador le pregunta a la base (esquema §5.2). Las lecturas reciben la
// transacción abierta como la persona; los cambios, como el servidor. Ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);
const state = z.enum(COURSE_STATES);
// Las revisiones son bigint: llegan como texto y se leen como número entero que cabe.
const count = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const instant = z.union([z.string(), z.date()]).transform((value) => (value instanceof Date ? value.toISOString() : value));

const teacherCourseRow = z.object({ course_id: id, state, title: z.string(), updated_at: instant, has_draft: z.boolean() });

/**
 * Los cursos del maestro de la sesión. La política del registro le da a Contenido todos: por eso
 * se filtra además por el maestro, explícito. El título es el del borrador, o el publicado.
 */
export async function readTeacherCourses(tx: Tx): Promise<TeacherCourse[]> {
  const rows = await tx.query(
    sql`select r.course_id, r.state, coalesce(d.title, p.title, '') as title,
               coalesce(d.updated_at, r.updated_at) as updated_at, d.course_id is not null as has_draft
        from public.course_registry r
        left join public.course_drafts d on d.course_id = r.course_id
        left join public.published_courses p on p.course_id = r.course_id
        where r.teacher_id = (select private.current_teacher_id())
        order by coalesce(d.updated_at, r.updated_at) desc, r.course_id`,
    teacherCourseRow,
  );
  return rows.map((row) => ({
    id: row.course_id,
    state: row.state,
    title: row.title,
    updatedAt: row.updated_at,
    hasDraft: row.has_draft,
  }));
}

const draftRow = z.object({
  course_id: id,
  state,
  version: z.number().int().min(1),
  title: z.string(),
  summary: z.string().nullable(),
  practice_id: id.nullable(),
  level_id: id.nullable(),
  revision: count,
  structure_revision: count,
  updated_at: instant,
});
const moduleRow = z.object({ id, title: z.string(), position: z.number().int().min(1), revision: count });
const lessonRow = z.object({
  id,
  module_id: id,
  title: z.string(),
  description: z.string().nullable(),
  position: z.number().int().min(1),
  revision: count,
});

/** El borrador entero del curso `course`, si es del maestro de la sesión; si no, nulo. */
export async function readDraftCourse(tx: Tx, course: string): Promise<DraftCourse | null> {
  const [draft] = await tx.query(
    sql`select d.course_id, r.state, d.version, d.title, d.summary, d.practice_id, d.level_id,
               d.revision, d.structure_revision, d.updated_at
        from public.course_drafts d
        join public.course_registry r on r.course_id = d.course_id
        where d.course_id = ${course}::uuid and d.teacher_id = (select private.current_teacher_id())`,
    draftRow,
  );
  if (!draft) return null;
  const modules = await tx.query(
    sql`select id, title, position, revision from public.draft_modules
        where course_id = ${course}::uuid order by position`,
    moduleRow,
  );
  const lessons = await tx.query(
    sql`select id, module_id, title, description, position, revision from public.draft_lessons
        where course_id = ${course}::uuid order by position`,
    lessonRow,
  );
  return {
    id: draft.course_id,
    state: draft.state,
    version: draft.version,
    title: draft.title,
    summary: draft.summary,
    practiceId: draft.practice_id,
    levelId: draft.level_id,
    revision: draft.revision,
    structureRevision: draft.structure_revision,
    updatedAt: draft.updated_at,
    modules: modules.map((module) => ({
      id: module.id,
      title: module.title,
      position: module.position,
      revision: module.revision,
      lessons: lessons
        .filter((lesson) => lesson.module_id === module.id)
        .map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          position: lesson.position,
          revision: lesson.revision,
        })),
    })),
  };
}

const resultRow = z.object({ result: z.unknown() });
const resultSchema = z.strictObject({
  answer: z.string(),
  course: id.optional(),
  module: id.optional(),
  lesson: id.optional(),
});

/** Lo que contestó una función del borrador: la respuesta y, si trae, el id de lo nuevo. Otra forma lanza. */
async function ask(tx: Tx, query: ReturnType<typeof sql>): Promise<{ answer: string; id: string | null }> {
  const [row] = await tx.query(query, resultRow);
  const result = resultSchema.parse(row?.result ?? null);
  return { answer: result.answer, id: result.course ?? result.module ?? result.lesson ?? null };
}

export const askCreate = (tx: Tx, title: string) => ask(tx, sql`select private.draft_create(${title}::text) as result`);

export const askSaveCourse = (tx: Tx, course: string, seen: number, fields: CourseFields) =>
  ask(
    tx,
    sql`select private.draft_save_course(${course}::uuid, ${seen}::bigint, ${fields.title}::text, ${fields.summary}::text,
                                         ${fields.practiceId}::uuid, ${fields.levelId}::uuid) as result`,
  );

export const askAddModule = (tx: Tx, course: string, seen: number, title: string) =>
  ask(tx, sql`select private.draft_add_module(${course}::uuid, ${seen}::bigint, ${title}::text) as result`);

export const askRenameModule = (tx: Tx, course: string, module: string, seen: number, title: string) =>
  ask(tx, sql`select private.draft_rename_module(${course}::uuid, ${module}::uuid, ${seen}::bigint, ${title}::text) as result`);

export const askDeleteModule = (tx: Tx, course: string, module: string, seen: number) =>
  ask(tx, sql`select private.draft_delete_module(${course}::uuid, ${module}::uuid, ${seen}::bigint) as result`);

export const askMoveModule = (tx: Tx, course: string, module: string, seenPosition: number, toPosition: number) =>
  ask(
    tx,
    sql`select private.draft_move_module(${course}::uuid, ${module}::uuid, ${seenPosition}::integer, ${toPosition}::integer) as result`,
  );

export const askAddLesson = (tx: Tx, course: string, module: string, seen: number, title: string) =>
  ask(tx, sql`select private.draft_add_lesson(${course}::uuid, ${module}::uuid, ${seen}::bigint, ${title}::text) as result`);

export const askSaveLesson = (tx: Tx, course: string, lesson: string, seen: number, title: string, description: string | null) =>
  ask(
    tx,
    sql`select private.draft_save_lesson(${course}::uuid, ${lesson}::uuid, ${seen}::bigint, ${title}::text, ${description}::text) as result`,
  );

export const askDeleteLesson = (tx: Tx, course: string, lesson: string, seen: number) =>
  ask(tx, sql`select private.draft_delete_lesson(${course}::uuid, ${lesson}::uuid, ${seen}::bigint) as result`);

export const askMoveLesson = (
  tx: Tx,
  course: string,
  lesson: string,
  seen: { module: string; position: number },
  to: { module: string; position: number },
) =>
  ask(
    tx,
    sql`select private.draft_move_lesson(${course}::uuid, ${lesson}::uuid, ${seen.module}::uuid, ${seen.position}::integer,
                                         ${to.module}::uuid, ${to.position}::integer) as result`,
  );

export const askDeleteCourse = (tx: Tx, course: string, seen: number) =>
  ask(tx, sql`select private.draft_delete_course(${course}::uuid, ${seen}::bigint) as result`);

/** Lo que contestó un cambio, como una de las respuestas de su lista. Otra cosa lanza. */
export function answerOf<Answer extends string>(known: readonly Answer[], answer: string): Answer {
  const found = known.find((each) => each === answer);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}

/** Lo que contestó crear o agregar. `created` siempre trae el id: sin él no se pintaría nada hecho, y lanza. */
export function createdOf<Answer extends string>(known: readonly Answer[], raw: { answer: string; id: string | null }) {
  const answer = answerOf(known, raw.answer);
  if (answer === "created" && raw.id === null) throw new Error("La base contestó sin el id que esa respuesta trae.");
  return { answer, id: answer === "created" ? raw.id : null };
}
