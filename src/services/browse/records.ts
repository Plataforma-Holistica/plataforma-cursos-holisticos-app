import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { CourseLessonRow, MyLessonProgress } from "./course";
import type { ShelfCourse } from "./shelf";

// Lo que el catálogo del alumno le pregunta a la base (T-210). Cada función recibe la
// transacción ya abierta. Lo público se lee como sistema y filtra a mano lo listado y lo
// vigente: el servidor salta la seguridad por fila, y estas páginas son las de cualquiera. Además
// del listado, el registro tiene que decir publicado (o con cambios pendientes): retirar quita lo
// listado por convención, y esto no depende de ella.

const courseRow = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  teacher_name: z.string(),
  teacher_slug: z.string().nullable(),
  practice_slug: z.string().nullable(),
  practice_name: z.string().nullable(),
  practice_tone: z.number().int().min(1).max(8).nullable(),
  practice_position: z.number().int().nullable(),
  level_slug: z.string().nullable(),
  level_name: z.string().nullable(),
  level_position: z.number().int().nullable(),
  lesson_count: z.number().int(),
  total_duration_seconds: z.number().int(),
  published_at: z.string().transform((value) => new Date(value)),
  is_open: z.boolean(),
});

function shelfCourseOf(row: z.infer<typeof courseRow>): ShelfCourse {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    teacherName: row.teacher_name,
    teacherSlug: row.teacher_slug,
    practice:
      row.practice_slug === null || row.practice_name === null || row.practice_tone === null || row.practice_position === null
        ? null
        : { slug: row.practice_slug, name: row.practice_name, tone: row.practice_tone, position: row.practice_position },
    level:
      row.level_slug === null || row.level_name === null || row.level_position === null
        ? null
        : { slug: row.level_slug, name: row.level_name, position: row.level_position },
    lessonCount: row.lesson_count,
    totalSeconds: row.total_duration_seconds,
    publishedAt: row.published_at,
    isOpen: row.is_open,
  };
}

/** Cuántos cursos listados se leen, los más nuevos: el catálogo del arranque cabe de sobra. */
const COURSES_READ = 500;

/**
 * Los cursos listados, los más nuevos primero. Una práctica o un nivel desactivados no se
 * nombran (el curso sigue listado: retirarlo es otra decisión). El maestro va con su slug solo
 * si está listado: si no, su ficha no existe y no se enlaza. Si el curso es el abierto lo dice
 * su registro, como en la función única de medios.
 */
export async function readListedCourses(tx: Tx): Promise<ShelfCourse[]> {
  const rows = await tx.query(
    sql`select c.slug, c.title, c.summary, c.teacher_name, t.slug as teacher_slug,
               p.slug as practice_slug, p.name as practice_name, p.cover_tone as practice_tone, p.position as practice_position,
               lv.slug as level_slug, lv.name as level_name, lv.position as level_position,
               c.lesson_count, c.total_duration_seconds, c.published_at::text as published_at, r.is_open
        from public.published_courses c
        join public.course_registry r on r.course_id = c.course_id and r.state in ('published', 'changes_pending')
        left join public.practices p on p.id = c.practice_id and p.is_active
        left join public.levels lv on lv.id = c.level_id and lv.is_active
        left join public.published_teachers t on t.teacher_id = c.teacher_id and t.is_listed
        where c.is_listed
        order by c.published_at desc, c.slug
        limit ${COURSES_READ}`,
    courseRow,
  );
  return rows.map(shelfCourseOf);
}

const matchRow = z.object({ kind: z.enum(["course", "teacher"]), slug: z.string() });

/**
 * Lo que encuentra la búsqueda `q` (RF-304): los cursos listados por su título y el nombre de su
 * maestro, y los maestros listados por su nombre. Sin acentos y por el principio de cada palabra:
 * la consulta la arma la base (`private.catalog_query`), que no deja pasar operadores.
 */
export async function searchCatalog(tx: Tx, q: string): Promise<{ courses: string[]; teachers: string[] }> {
  const rows = await tx.query(
    sql`with wanted as (select private.catalog_query(${q}) as query)
        select 'course' as kind, c.slug
        from public.published_courses c
        join public.course_registry r on r.course_id = c.course_id and r.state in ('published', 'changes_pending')
        cross join wanted
        where c.is_listed and c.search_tsv @@ wanted.query
        union all
        select 'teacher' as kind, t.slug
        from public.published_teachers t
        cross join wanted
        where t.is_listed and private.catalog_search(t.display_name) @@ wanted.query`,
    matchRow,
  );
  return {
    courses: rows.filter((row) => row.kind === "course").map((row) => row.slug),
    teachers: rows.filter((row) => row.kind === "teacher").map((row) => row.slug),
  };
}

const teacherRow = z.object({ slug: z.string(), display_name: z.string(), bio: z.string().nullable() });

/** Un maestro listado, por su slug, o nulo. */
export async function readListedTeacher(tx: Tx, slug: string): Promise<{ slug: string; name: string; bio: string | null } | null> {
  const [row] = await tx.query(
    sql`select slug, display_name, bio from public.published_teachers where slug = ${slug} and is_listed`,
    teacherRow,
  );
  return row === undefined ? null : { slug: row.slug, name: row.display_name, bio: row.bio };
}

const detailRow = z.object({
  teacher_slug: z.string().nullable(),
  teacher_name: z.string().nullable(),
  teacher_bio: z.string().nullable(),
  module_id: z.string(),
  module_title: z.string(),
  module_position: z.number().int(),
  lesson_id: z.string(),
  lesson_title: z.string(),
  lesson_position: z.number().int(),
  duration_seconds: z.number().int(),
});

/** Las lecciones vigentes del curso listado `slug`, con sus módulos vigentes y su maestro si está listado. */
export async function readCourseLessons(
  tx: Tx,
  slug: string,
): Promise<{ teacher: { slug: string; name: string; bio: string | null } | null; lessons: CourseLessonRow[] }> {
  const rows = await tx.query(
    sql`select t.slug as teacher_slug, t.display_name as teacher_name, t.bio as teacher_bio,
               m.id::text as module_id, m.title as module_title, m.position as module_position,
               l.id::text as lesson_id, l.title as lesson_title, l.position as lesson_position, l.duration_seconds
        from public.published_courses c
        join public.course_registry r on r.course_id = c.course_id and r.state in ('published', 'changes_pending')
        join public.published_modules m on m.course_id = c.course_id and m.is_current
        join public.published_lessons l on l.module_id = m.id and l.course_id = c.course_id and l.is_current
        left join public.published_teachers t on t.teacher_id = c.teacher_id and t.is_listed
        where c.slug = ${slug} and c.is_listed`,
    detailRow,
  );
  const first = rows[0];
  const teacher =
    first === undefined || first.teacher_slug === null || first.teacher_name === null
      ? null
      : { slug: first.teacher_slug, name: first.teacher_name, bio: first.teacher_bio };
  return {
    teacher,
    lessons: rows.map((row) => ({
      moduleId: row.module_id,
      moduleTitle: row.module_title,
      modulePosition: row.module_position,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_title,
      lessonPosition: row.lesson_position,
      durationSeconds: row.duration_seconds,
    })),
  };
}

const progressRow = z.object({
  lesson_id: z.string(),
  covered_seconds: z.number().int().nonnegative(),
  last_position_seconds: z.number().int().nonnegative(),
  completed: z.boolean(),
  same_video: z.boolean(),
  last_watched_at: z.string().transform((value) => new Date(value)),
});

/**
 * Lo guardado de quien lee en las lecciones vigentes del curso listado `slug`. Se lee como la
 * persona: la política solo le deja ver su progreso, y la consulta lo pide además a mano.
 */
export async function readMyCourseProgress(tx: Tx, slug: string): Promise<MyLessonProgress[]> {
  const rows = await tx.query(
    sql`select p.lesson_id::text as lesson_id, p.covered_seconds, p.last_position_seconds,
               p.completed_at is not null as completed, p.video_asset_id = l.video_asset_id as same_video,
               p.last_watched_at::text as last_watched_at
        from public.published_courses c
        join public.published_lessons l on l.course_id = c.course_id and l.is_current
        join public.lesson_progress p on p.lesson_id = l.id and p.profile_id = (select auth.uid())
        where c.slug = ${slug} and c.is_listed`,
    progressRow,
  );
  return rows.map((row) => ({
    lessonId: row.lesson_id,
    facts: { coveredSeconds: row.covered_seconds, position: row.last_position_seconds, completed: row.completed, sameVideo: row.same_video },
    lastWatchedAt: row.last_watched_at,
  }));
}
