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
});

/**
 * Las lecciones vigentes del curso `slug`, si está listado, con sus módulos vigentes. Se lee
 * como la persona, pero **filtrando a mano lo listado y lo vigente**: el maestro dueño y quien
 * tiene Contenido ven más por sus políticas (lo suyo sin listar, lo retirado), y esta página es
 * la del alumno. Lo suyo sin listar lo verá el maestro en su vista previa (PA-43).
 */
export async function readCourseLessons(tx: Tx, slug: string): Promise<LessonRowData[]> {
  const rows = await tx.query(
    sql`select c.slug as course_slug, c.title as course_title, c.summary as course_summary, c.teacher_name,
               m.id::text as module_id, m.title as module_title, m.position as module_position,
               l.id::text as lesson_id, l.title as lesson_title, l.position as lesson_position, l.duration_seconds
        from public.published_courses c
        join public.published_modules m on m.course_id = c.course_id and m.is_current
        join public.published_lessons l on l.module_id = m.id and l.course_id = c.course_id and l.is_current
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
  }));
}

const openRow = z.object({ is_open: z.boolean() });

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
