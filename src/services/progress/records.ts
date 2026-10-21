import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { ContinueRowData } from "./continue";

// Lo que «continuar viendo» le pregunta a la base (T-206). Cada función recibe la transacción ya
// abierta.

const continueRow = z.object({
  course_slug: z.string(),
  course_title: z.string(),
  teacher_name: z.string(),
  last_watched_at: z.string().transform((value) => new Date(value)),
  last_lesson_id: z.string().nullable(),
  lesson_id: z.string(),
  lesson_title: z.string(),
  module_position: z.number().int(),
  lesson_position: z.number().int(),
  completed: z.boolean(),
});

/** Cuántos cursos empezados se leen, los más recientes: de ahí salen los de la fila. */
const COURSES_READ = 50;

/**
 * Las lecciones vigentes de los cursos listados que quien lee empezó, con si terminó cada una,
 * cuándo vio algo del curso por última vez y qué lección. Se lee como la persona: la política
 * solo le deja ver su progreso, y la consulta lo pide además a mano. Lo listado y lo vigente se
 * filtran a mano, como en la página de la lección: el maestro dueño y Contenido ven más por sus
 * políticas. Un curso que se dejó de listar sale de la lista y su progreso se conserva (FL-13
 * E2). La última lección vista cuenta aunque ya no esté vigente: la regla de la sugerida lo sabe.
 *
 * Se leen a lo más los 50 cursos más recientes, ya sin los terminados ni los que no se listan:
 * de ahí salen los 20 de la fila. Un curso donde solo vio un video que la lección ya cambió
 * sigue contando como empezado (lo empezó), aunque su temario diga «sin empezar».
 */
export async function readContinueWatching(tx: Tx): Promise<ContinueRowData[]> {
  const rows = await tx.query(
    sql`with mine as (
          select p.course_id, max(p.last_watched_at) as last_watched_at,
                 (array_agg(p.lesson_id order by p.last_watched_at desc, p.lesson_id))[1] as last_lesson_id
          from public.lesson_progress p
          join public.published_courses c on c.course_id = p.course_id and c.is_listed
          where p.profile_id = (select auth.uid())
            -- Con alguna lección vigente sin terminar: el tope se aplica a lo que va a la fila.
            and exists (
              select 1
              from public.published_modules m
              join public.published_lessons l on l.module_id = m.id and l.course_id = m.course_id and l.is_current
              left join public.lesson_progress q on q.lesson_id = l.id and q.profile_id = (select auth.uid())
              where m.course_id = p.course_id and m.is_current and q.completed_at is null)
          group by p.course_id
          order by max(p.last_watched_at) desc
          limit ${COURSES_READ}
        )
        select c.slug as course_slug, c.title as course_title, c.teacher_name,
               mine.last_watched_at::text as last_watched_at, mine.last_lesson_id::text as last_lesson_id,
               l.id::text as lesson_id, l.title as lesson_title, m.position as module_position, l.position as lesson_position,
               coalesce(p.completed_at is not null, false) as completed
        from mine
        join public.published_courses c on c.course_id = mine.course_id and c.is_listed
        join public.published_modules m on m.course_id = c.course_id and m.is_current
        join public.published_lessons l on l.module_id = m.id and l.course_id = c.course_id and l.is_current
        left join public.lesson_progress p on p.lesson_id = l.id and p.profile_id = (select auth.uid())`,
    continueRow,
  );
  return rows.map((row) => ({
    courseSlug: row.course_slug,
    courseTitle: row.course_title,
    teacherName: row.teacher_name,
    lastWatchedAt: row.last_watched_at,
    lastLessonId: row.last_lesson_id,
    lessonId: row.lesson_id,
    lessonTitle: row.lesson_title,
    modulePosition: row.module_position,
    lessonPosition: row.lesson_position,
    completed: row.completed,
  }));
}
