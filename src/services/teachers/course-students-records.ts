import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { CourseStudentsAnswer, StudentsQuery } from "./course-students";

// Lo que el avance de los alumnos le pregunta a la base, como el servidor y a nombre de la persona (PA-51, T-408). `teacher_course_students` se nombra
// solo aquí. La respuesta se lee con una forma estricta: si la base trajera una clave de más (un identificador, una fecha por alumno), falla y es «no se
// supo». Lo que no cuadra entre sí (cifras que no suman, una lista sin su lunes) tampoco tiene forma.

const answerRow = z.object({ answer: z.unknown() }).strict();

const count = z.number().int().min(0);
const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
// La forma del alias, la de la base: una palabra y un número de dos a cuatro cifras.
const alias = z.string().regex(/^[A-Z][a-z]+ [1-9][0-9]{1,3}$/);

const figures = z
  .object({ started: count, in_progress: count, finished: count, cut_at: instant })
  .strict()
  .refine((f) => f.started === f.in_progress + f.finished);

const student = z
  .object({ alias, completed: count, total: z.number().int().min(1) })
  .strict()
  .refine((s) => s.completed <= s.total);

const okAnswer = z
  .object({
    outcome: z.literal("ok"),
    title: z.string(),
    figures: figures.nullable(),
    lessons: z.array(z.object({ title: z.string(), finished: count.nullable() }).strict()),
    students: z.array(student).max(50),
    page: z.number().int().min(1),
    pages: z.number().int().min(1),
    total_students: count,
    list_cut_at: instant.nullable(),
    stale: z.boolean(),
  })
  .strict()
  .refine((a) => a.lessons.every((lesson) => (lesson.finished === null) === (a.figures === null)))
  .refine((a) => a.list_cut_at !== null || (a.students.length === 0 && a.total_students === 0))
  .refine((a) => a.page <= a.pages);

const studentsAnswer = z.union([okAnswer, z.object({ outcome: z.literal("not_teacher") }).strict(), z.object({ outcome: z.literal("not_found") }).strict()]);

export async function askCourseStudents(tx: Tx, query: StudentsQuery): Promise<CourseStudentsAnswer> {
  const rows = await tx.query(
    sql`select private.teacher_course_students(${query.course}::uuid, ${query.order}::text, ${query.page}::integer) as answer`,
    answerRow,
  );
  const a = studentsAnswer.parse(rows[0]?.answer);
  if (a.outcome !== "ok") return a;
  return {
    outcome: "ok",
    value: {
      title: a.title,
      figures:
        a.figures === null
          ? null
          : { started: a.figures.started, inProgress: a.figures.in_progress, finished: a.figures.finished, cutAt: new Date(a.figures.cut_at).toISOString() },
      lessons: a.lessons.map((lesson) => ({ title: lesson.title, finished: lesson.finished })),
      students: a.students.map((s) => ({ alias: s.alias, completed: s.completed, total: s.total })),
      page: a.page,
      pages: a.pages,
      totalStudents: a.total_students,
      listCutAt: a.list_cut_at === null ? null : new Date(a.list_cut_at).toISOString(),
      stale: a.stale,
    },
  };
}
