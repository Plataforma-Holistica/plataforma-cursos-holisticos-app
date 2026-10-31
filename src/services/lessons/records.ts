import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { LessonRowData } from "./page";

// Lo que la página de una lección le pregunta a la base. Cada función recibe la transacción ya
// abierta.

const lessonRow = z.object({
  course_slug: z.string(),
  course_title: z.string(),
  course_summary: z.string().nullable(),
  teacher_name: z.string(),
  module_id: z.string(),
  module_title: z.string(),
  module_position: z.number().int(),
  lesson_id: z.string(),
  lesson_title: z.string(),
  lesson_position: z.number().int(),
  duration_seconds: z.number().int(),
  covered_seconds: z.number().int().nonnegative().nullable(),
  last_position_seconds: z.number().int().nonnegative().nullable(),
  completed: z.boolean().nullable(),
  same_video: z.boolean().nullable(),
});

/**
 * Las lecciones vigentes del curso `slug`, si está listado, con sus módulos vigentes. Se lee
 * como la persona, pero **filtrando a mano lo listado y lo vigente**: el maestro dueño y quien
 * tiene Contenido ven más por sus políticas (lo suyo sin listar, lo retirado), y esta página es
 * la del alumno. Lo suyo sin listar lo verá el maestro en su vista previa (PA-43).
 *
 * Con cada lección, el progreso de quien lee (T-206): la política solo le deja ver el suyo, y la
 * consulta lo pide además a mano. Si lo guardado es de otro video, se dice: sus tramos ya no
 * cuentan, y si la terminó, sigue terminada.
 */
export async function readCourseLessons(tx: Tx, slug: string): Promise<LessonRowData[]> {
  const rows = await tx.query(
    sql`select c.slug as course_slug, c.title as course_title, c.summary as course_summary, c.teacher_name,
               m.id::text as module_id, m.title as module_title, m.position as module_position,
               l.id::text as lesson_id, l.title as lesson_title, l.position as lesson_position, l.duration_seconds,
               p.covered_seconds, p.last_position_seconds, p.completed_at is not null as completed,
               p.video_asset_id = l.video_asset_id as same_video
        from public.published_courses c
        join public.published_modules m on m.course_id = c.course_id and m.is_current
        join public.published_lessons l on l.module_id = m.id and l.course_id = c.course_id and l.is_current
        left join public.lesson_progress p on p.lesson_id = l.id and p.profile_id = (select auth.uid())
        where c.slug = ${slug} and c.is_listed`,
    lessonRow,
  );
  return rows.map((row) => ({
    courseSlug: row.course_slug,
    courseTitle: row.course_title,
    courseSummary: row.course_summary,
    teacherName: row.teacher_name,
    moduleId: row.module_id,
    moduleTitle: row.module_title,
    modulePosition: row.module_position,
    lessonId: row.lesson_id,
    lessonTitle: row.lesson_title,
    lessonPosition: row.lesson_position,
    durationSeconds: row.duration_seconds,
    progress:
      row.covered_seconds === null || row.last_position_seconds === null || row.completed === null || row.same_video === null
        ? null
        : { coveredSeconds: row.covered_seconds, position: row.last_position_seconds, completed: row.completed, sameVideo: row.same_video },
  }));
}

const openRow = z.object({ is_open: z.boolean() });

/** Un recurso vigente de una lección (T-404). La ruta del archivo no la lee ninguna persona: la suelta la puerta de medios. */
export interface LessonResourceRow {
  id: string;
  title: string;
  kind: "pdf" | "doc" | "audio";
  sizeBytes: number;
}

const resourceRow = z.object({ id: z.string(), title: z.string(), kind: z.enum(["pdf", "doc", "audio"]), size_bytes: z.number().int() });

/** Se lee como la persona: la política solo le deja ver los de una lección vigente de un curso listado, o de los suyos. */
export async function readLessonResources(tx: Tx, lessonId: string): Promise<LessonResourceRow[]> {
  const rows = await tx.query(
    sql`select x.id::text as id, x.title, x.kind::text as kind, x.size_bytes::integer as size_bytes
        from public.published_resources x
        where x.lesson_id = ${lessonId}::uuid and x.is_current
        order by x.position`,
    resourceRow,
  );
  return rows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, sizeBytes: row.size_bytes }));
}

/**
 * Si el curso `slug` es el abierto (RF-309), o nulo si no existe o no está listado. Lo dice el
 * registro del curso, como en la función única de medios (`private.media_facts`): la copia de
 * lo publicado no manda. Solo eso sale de aquí: lo usa la guarda para saber a dónde mandar a
 * quien llega sin sesión.
 */
export async function readCourseIsOpen(tx: Tx, slug: string): Promise<boolean | null> {
  const [row] = await tx.query(
    sql`select r.is_open
        from public.published_courses c
        join public.course_registry r on r.course_id = c.course_id
        where c.slug = ${slug} and c.is_listed`,
    openRow,
  );
  return row === undefined ? null : row.is_open;
}
