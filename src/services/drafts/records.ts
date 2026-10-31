import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { COURSE_STATES, type CourseFields, type DraftChoices, type DraftCourse, type TeacherCourse } from "./drafts";

// Lo que el servicio del borrador le pregunta a la base (esquema §5.2). Las lecturas reciben la
// transacción abierta como la persona; los cambios, como el servidor. Ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);
const state = z.enum(COURSE_STATES);
// Las revisiones son bigint: llegan como texto y se leen como número entero que cabe.
const count = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const instant = z.union([z.string(), z.date()]).transform((value) => (value instanceof Date ? value.toISOString() : value));

const tally = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const teacherCourseRow = z.object({
  course_id: id,
  state,
  title: z.string(),
  updated_at: instant,
  content_revision: count.nullable(),
  teacher_name: z.string().nullable(),
  practice_name: z.string().nullable(),
  cover_tone: z.number().int().min(1).max(8).nullable(),
  has_draft: z.boolean(),
  has_summary: z.boolean(),
  practice_ready: z.boolean(),
  level_ready: z.boolean(),
  lessons: tally,
  modules_with_lessons: tally,
});

/**
 * Los cursos del maestro de la sesión. La política del registro le da a Contenido todos: por eso
 * se filtra además por el maestro, explícito. El título es el del borrador, o el publicado. Lo que
 * cuenta «Faltan {n} cosas» va en la misma consulta: la persona solo lee las prácticas y los niveles
 * activos, y uno desactivado cuenta como que falta (además se pide `is_active`, explícito).
 */
export async function readTeacherCourses(tx: Tx): Promise<TeacherCourse[]> {
  const rows = await tx.query(
    sql`select r.course_id, r.state, coalesce(d.title, p.title, '') as title,
               coalesce(d.updated_at, r.updated_at) as updated_at, d.content_revision,
               (select pr.display_name from public.profiles pr where pr.id = (select auth.uid())) as teacher_name,
               pc.name as practice_name, pc.cover_tone,
               d.course_id is not null as has_draft,
               d.summary is not null as has_summary,
               pc.id is not null as practice_ready,
               exists (select 1 from public.levels lv where lv.id = d.level_id and lv.is_active) as level_ready,
               (select count(*) from public.draft_lessons l where l.course_id = d.course_id) as lessons,
               (select count(distinct l.module_id) from public.draft_lessons l where l.course_id = d.course_id) as modules_with_lessons
        from public.course_registry r
        left join public.course_drafts d on d.course_id = r.course_id
        left join public.published_courses p on p.course_id = r.course_id
        left join public.practices pc on pc.id = d.practice_id and pc.is_active
        where r.teacher_id = (select private.current_teacher_id())
        order by coalesce(d.updated_at, r.updated_at) desc, r.course_id`,
    teacherCourseRow,
  );
  return rows.map((row) => ({
    id: row.course_id,
    state: row.state,
    title: row.title,
    updatedAt: row.updated_at,
    contentRevision: row.content_revision,
    teacherName: row.teacher_name,
    practiceName: row.practice_name,
    coverTone: row.cover_tone,
    draft: row.has_draft
      ? {
          hasSummary: row.has_summary,
          practiceReady: row.practice_ready,
          levelReady: row.level_ready,
          lessons: row.lessons,
          modulesWithLessons: row.modules_with_lessons,
        }
      : null,
  }));
}

const lessonSchema = z.strictObject({
  id,
  title: z.string(),
  description: z.string().nullable(),
  position: z.number().int().min(1),
  revision: count,
});
const moduleSchema = z.strictObject({
  id,
  title: z.string(),
  position: z.number().int().min(1),
  revision: count,
  lessons: z.array(lessonSchema),
});
const resourceSchema = z.strictObject({
  id,
  lessonId: id.nullable(),
  title: z.string(),
  kind: z.enum(["pdf", "doc", "audio"]),
  sizeBytes: z.number().int().min(1),
  position: z.number().int().min(1),
  revision: count,
});
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
  content_revision: count,
  updated_at: instant,
  modules: z.array(moduleSchema),
  resources: z.array(resourceSchema),
  teacher_name: z.string().nullable(),
});

/**
 * El borrador entero del curso `course`, si es del maestro de la sesión; si no, nulo. En una sola
 * consulta: con varias, en read committed, cada una vería otra foto, y una lección que se movió entre
 * dos de ellas a un módulo nuevo se perdería de la vista.
 */
export async function readDraftCourse(tx: Tx, course: string): Promise<DraftCourse | null> {
  const [draft] = await tx.query(
    sql`select d.course_id, r.state, d.version, d.title, d.summary, d.practice_id, d.level_id,
               d.revision, d.structure_revision, d.content_revision, d.updated_at,
               (select pr.display_name from public.profiles pr where pr.id = (select auth.uid())) as teacher_name,
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', m.id, 'title', m.title, 'position', m.position, 'revision', m.revision,
                          'lessons', coalesce((
                            select jsonb_agg(jsonb_build_object(
                                     'id', l.id, 'title', l.title, 'description', l.description,
                                     'position', l.position, 'revision', l.revision) order by l.position)
                            from public.draft_lessons l where l.module_id = m.id), '[]'::jsonb))
                        order by m.position)
                 from public.draft_modules m where m.course_id = d.course_id), '[]'::jsonb) as modules,
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', x.id, 'lessonId', x.lesson_id, 'title', x.title, 'kind', x.kind,
                          'sizeBytes', x.size_bytes, 'position', x.position, 'revision', x.revision)
                        order by x.place_id, x.position)
                 from public.draft_resources x where x.course_id = d.course_id and x.state = 'ready'), '[]'::jsonb) as resources
        from public.course_drafts d
        join public.course_registry r on r.course_id = d.course_id
        where d.course_id = ${course}::uuid and d.teacher_id = (select private.current_teacher_id())`,
    draftRow,
  );
  if (!draft) return null;
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
    contentRevision: draft.content_revision,
    updatedAt: draft.updated_at,
    modules: draft.modules,
    resources: draft.resources,
    teacherName: draft.teacher_name,
  };
}

const choice = { id, name: z.string(), active: z.boolean() };
const choicesRow = z.object({
  practices: z.array(z.strictObject({ ...choice, tone: z.number().int().min(1).max(8) })),
  levels: z.array(z.strictObject(choice)),
  max_bytes: z.coerce.number().int().nullable(),
  per_place: z.coerce.number().int().nullable(),
});

/**
 * Lo que el editor ofrece: las prácticas y los niveles activos, más los elegidos aunque se hayan
 * desactivado, en su orden. Se lee como sistema: una cuenta no lee una desactivada. Los ids elegidos
 * salen del borrador que la persona ya leyó como ella; lo que se lee aquí son nombres del catálogo.
 */
export async function readDraftChoices(tx: Tx, practiceId: string | null, levelId: string | null): Promise<DraftChoices> {
  const [row] = await tx.query(
    sql`select
          coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'tone', x.cover_tone, 'active', x.is_active)
                                     order by x.position)
                    from public.practices x where x.is_active or x.id = ${practiceId}::uuid), '[]'::jsonb) as practices,
          coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'active', x.is_active) order by x.position)
                    from public.levels x where x.is_active or x.id = ${levelId}::uuid), '[]'::jsonb) as levels,
          (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint as max_bytes,
          (private.parameter_value('RECURSOS_POR_LUGAR_MAX'))::integer as per_place`,
    choicesRow,
  );
  if (!row) return { practices: [], levels: [], resourceLimits: { maxBytes: null, perPlace: null } };
  return { practices: row.practices, levels: row.levels, resourceLimits: { maxBytes: row.max_bytes, perPlace: row.per_place } };
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

export const askCreate = (tx: Tx, token: string, title: string) =>
  ask(tx, sql`select private.draft_create(${token}::uuid, ${title}::text) as result`);

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

// ---------------------------------------------------------------------------------------
// Los recursos (T-404). La ruta sale de la base y no va a ningún registro.

const resourceResultSchema = z.strictObject({
  answer: z.string(),
  resource: id.optional(),
  path: z.string().optional(),
  mime: z.string().optional(),
  reason: z.string().optional(),
});
export type ResourceResult = z.infer<typeof resourceResultSchema>;

async function askResource(tx: Tx, query: ReturnType<typeof sql>): Promise<ResourceResult> {
  const [row] = await tx.query(query, resultRow);
  return resourceResultSchema.parse(row?.result ?? null);
}

export const askResourceBegin = (tx: Tx, input: { course: string; lesson: string | null; title: string; kind: string; mime: string; size: number }) =>
  askResource(
    tx,
    sql`select private.resource_begin(${input.course}::uuid, ${input.lesson}::uuid, ${input.title}::text, ${input.kind}::text,
                                      ${input.mime}::text, ${input.size}::bigint) as result`,
  );

export const askResourceFile = (tx: Tx, input: { course: string; resource: string }) =>
  askResource(tx, sql`select private.resource_file(${input.course}::uuid, ${input.resource}::uuid) as result`);

export const askResourceConfirm = (tx: Tx, input: { course: string; resource: string; contentOk: boolean | null }) =>
  askResource(tx, sql`select private.resource_confirm(${input.course}::uuid, ${input.resource}::uuid, ${input.contentOk}::boolean) as result`);

export const askResourceMove = (tx: Tx, input: { course: string; resource: string; seenPosition: number; toPosition: number }) =>
  askResource(tx, sql`select private.resource_move(${input.course}::uuid, ${input.resource}::uuid, ${input.seenPosition}::integer, ${input.toPosition}::integer) as result`);

export const askResourceRemove = (tx: Tx, input: { course: string; resource: string; seen: number }) =>
  askResource(tx, sql`select private.resource_remove(${input.course}::uuid, ${input.resource}::uuid, ${input.seen}::bigint) as result`);

const unusedRow = z.object({ path: z.string() });

export async function readUnusedResources(tx: Tx, course: string): Promise<string[]> {
  const rows = await tx.query(sql`select u.path from private.resource_unused_objects(${course}::uuid) u`, unusedRow);
  return rows.map((row) => row.path);
}
