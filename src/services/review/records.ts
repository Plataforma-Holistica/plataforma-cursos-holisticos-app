import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { APPROVE_ANSWERS, LESSON_VIDEOS, type ApproveAnswer, type ReviewQueue } from "./queue";

// Lo que el servicio de revisión le pregunta a la base (esquema, «Lo publicado»): la cola para
// la pantalla, y aprobar un curso. Cada función recibe la transacción ya abierta como
// servidor; ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);

// Estrictos: un campo que este código no conoce no pasa. Así un playback id que alguien
// agregue a la función de la base no llega a la pantalla sin que esto cambie a la vista.
const queueSchema = z.strictObject({
  fresh_code: z.boolean(),
  courses: z.array(
    z.strictObject({
      course_id: id,
      title: z.string(),
      teacher_name: z.string(),
      teacher_listed: z.boolean(),
      practice: z.string().nullable(),
      level: z.string().nullable(),
      lesson_count: z.number().int().min(0),
      total_duration_seconds: z.number().int().min(0),
      loaded_at: z.string(),
      lessons: z.array(
        z.strictObject({
          lesson_id: id,
          module: z.string(),
          title: z.string(),
          duration_seconds: z.number().int().min(0),
          video: z.enum(LESSON_VIDEOS),
        }),
      ),
    }),
  ),
});

/** Lo que contestó `private.review_queue()`, o nulo si contestó nulo. Otra forma lanza. */
export function queueOf(raw: unknown): ReviewQueue | null {
  if (raw === null) return null;
  const queue = queueSchema.parse(raw);
  return {
    freshCode: queue.fresh_code,
    courses: queue.courses.map((course) => ({
      courseId: course.course_id,
      title: course.title,
      teacherName: course.teacher_name,
      teacherListed: course.teacher_listed,
      practice: course.practice,
      level: course.level,
      lessonCount: course.lesson_count,
      totalDurationSeconds: course.total_duration_seconds,
      loadedAt: course.loaded_at,
      lessons: course.lessons.map((lesson) => ({
        lessonId: lesson.lesson_id,
        module: lesson.module,
        title: lesson.title,
        durationSeconds: lesson.duration_seconds,
        video: lesson.video,
      })),
    })),
  };
}

/** La respuesta de la base, si está en la lista. Otra lanza: no se pinta como hecha. */
export function approveAnswerOf(answer: string): ApproveAnswer {
  const found = APPROVE_ANSWERS.find((each) => each === answer);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}

const queueRow = z.object({ queue: z.unknown() });
const answerRow = z.object({ answer: z.string() });

export async function readReviewQueue(tx: Tx): Promise<ReviewQueue | null> {
  const [row] = await tx.query(sql`select private.review_queue() as queue`, queueRow);
  if (!row) throw new Error("La base no contestó la cola de revisión.");
  return queueOf(row.queue);
}

/** Aprueba (`private.approve_course()`). Devuelve lo que contestó, sin juzgarlo. */
export async function askApprove(tx: Tx, courseId: string): Promise<string> {
  const [row] = await tx.query(sql`select private.approve_course(${courseId}::uuid) as answer`, answerRow);
  return row?.answer ?? "";
}
