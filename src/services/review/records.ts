import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import {
  APPROVE_ANSWERS,
  LESSON_VIDEOS,
  RETURN_ANSWERS,
  SUBMISSION_APPROVE_ANSWERS,
  type ApproveAnswer,
  type ApproveAssets,
  type CourseReturn,
  type ReturnAnswer,
  type ReviewQueue,
  type ReviewResource,
  type SubmissionApproveAnswer,
  type VersionChanges,
} from "./queue";

// Lo que el servicio de revisión le pregunta a la base (esquema, «Lo publicado»): la cola para
// la pantalla, y aprobar un curso. Cada función recibe la transacción ya abierta como
// servidor; ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);

const resourceRow = z.strictObject({ id, title: z.string(), kind: z.enum(["pdf", "doc", "audio"]), size_bytes: z.number().int().min(0) });
const resourcesOf = (rows: z.infer<typeof resourceRow>[]): ReviewResource[] =>
  rows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, sizeBytes: row.size_bytes }));

const titles = z.array(z.string());
const changesRow = z.strictObject({
  course: z.array(z.enum(["title", "summary", "practice", "level"])),
  modules_added: titles,
  modules_removed: titles,
  modules_renamed: titles,
  modules_moved: titles,
  lessons_added: titles,
  lessons_removed: titles,
  lessons_video: titles,
  lessons_text: titles,
  lessons_moved: titles,
  resources_added: titles,
  resources_removed: titles,
  resources_renamed: titles,
  resources_moved: titles,
});
const changesOf = (row: z.infer<typeof changesRow> | null): VersionChanges | null =>
  row === null
    ? null
    : {
        course: row.course,
        modulesAdded: row.modules_added,
        modulesRemoved: row.modules_removed,
        modulesRenamed: row.modules_renamed,
        modulesMoved: row.modules_moved,
        lessonsAdded: row.lessons_added,
        lessonsRemoved: row.lessons_removed,
        lessonsVideo: row.lessons_video,
        lessonsText: row.lessons_text,
        lessonsMoved: row.lessons_moved,
        resourcesAdded: row.resources_added,
        resourcesRemoved: row.resources_removed,
        resourcesRenamed: row.resources_renamed,
        resourcesMoved: row.resources_moved,
      };

// Estrictos: un campo que este código no conoce no pasa. Así un playback id que alguien
// agregue a la función de la base no llega a la pantalla sin que esto cambie a la vista.
const queueSchema = z.strictObject({
  fresh_code: z.boolean(),
  courses: z.array(
    z.strictObject({
      course_id: id,
      title: z.string(),
      // Lo enviado por el editor suma lo suyo; un curso por guion sale como siempre.
      summary: z.string().nullable().optional(),
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
          module_id: id,
          module: z.string(),
          title: z.string(),
          duration_seconds: z.number().int().min(0),
          video: z.enum(LESSON_VIDEOS),
          description: z.string().nullable().optional(),
          resources: z.array(resourceRow).optional(),
        }),
      ),
      submission: z
        .strictObject({
          id,
          number: z.number().int().min(1),
          resources: z.array(resourceRow),
          captions_missing: z.array(id),
          files_changed: z.array(z.string()),
          version: z.number().int().min(1),
          is_revision: z.boolean(),
          changes: changesRow.nullable(),
          annex: z.strictObject({ version: z.number().int().min(0), accepted_at: z.string(), statement: z.string(), term_years: z.number().int().min(1) }),
        })
        .optional(),
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
      summary: course.summary ?? null,
      teacherName: course.teacher_name,
      teacherListed: course.teacher_listed,
      practice: course.practice,
      level: course.level,
      lessonCount: course.lesson_count,
      totalDurationSeconds: course.total_duration_seconds,
      loadedAt: course.loaded_at,
      lessons: course.lessons.map((lesson) => ({
        lessonId: lesson.lesson_id,
        moduleId: lesson.module_id,
        module: lesson.module,
        title: lesson.title,
        durationSeconds: lesson.duration_seconds,
        video: lesson.video,
        description: lesson.description ?? null,
        resources: resourcesOf(lesson.resources ?? []),
      })),
      submission:
        course.submission === undefined
          ? null
          : {
              id: course.submission.id,
              number: course.submission.number,
              resources: resourcesOf(course.submission.resources),
              annex: {
                version: course.submission.annex.version,
                acceptedAt: course.submission.annex.accepted_at,
                statement: course.submission.annex.statement,
                termYears: course.submission.annex.term_years,
              },
              captionsMissing: course.submission.captions_missing,
              filesChanged: course.submission.files_changed,
              version: course.submission.version,
              isRevision: course.submission.is_revision,
              changes: changesOf(course.submission.changes),
            },
    })),
  };
}

/** La respuesta de la base, si está en la lista. Otra lanza: no se pinta como hecha. */
export function approveAnswerOf(answer: string): ApproveAnswer {
  const found = APPROVE_ANSWERS.find((each) => each === answer);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}

/** La respuesta de devolver, si está en la lista. Otra lanza: no se pinta como hecha. */
export function returnAnswerOf(answer: string): ReturnAnswer {
  const found = RETURN_ANSWERS.find((each) => each === answer);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}

/** La respuesta de aprobar lo enviado, si está en la lista. Otra lanza: no se pinta como hecha. */
export function submissionApproveAnswerOf(answer: string): SubmissionApproveAnswer {
  const found = SUBMISSION_APPROVE_ANSWERS.find((each) => each === answer);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}

const assetsSchema = z.discriminatedUnion("answer", [
  z.strictObject({
    answer: z.literal("ok"),
    assets: z.array(z.strictObject({ video: id, lesson: id, provider: z.string(), asset: z.string().nullable(), playback: z.string().nullable() })),
  }),
  z.strictObject({ answer: z.enum(["forbidden", "needs_fresh_code", "not_found", "not_pending", "changed", "self"]) }),
]);

/** Lo que contestó `private.review_approve_assets()`. Otra forma lanza. */
export function approveAssetsOf(raw: unknown): ApproveAssets {
  const read = assetsSchema.parse(raw);
  return read.answer === "ok" ? { kind: "ok", assets: read.assets } : { kind: read.answer };
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

/** Los videos de lo enviado, para preguntarle a su proveedor antes de aprobar. */
export async function readApproveAssets(tx: Tx, input: { course: string; submission: string }): Promise<ApproveAssets> {
  const [row] = await tx.query(sql`select private.review_approve_assets(${input.course}::uuid, ${input.submission}::uuid) as assets`, z.object({ assets: z.unknown() }));
  if (!row) throw new Error("La base no contestó los videos de lo enviado.");
  return approveAssetsOf(row.assets);
}

/** Aprueba lo enviado (`private.review_approve()`). Devuelve lo que contestó, sin juzgarlo. */
export async function askApproveSubmission(tx: Tx, input: { course: string; submission: string; captions: string[] }): Promise<string> {
  const [row] = await tx.query(
    sql`select private.review_approve(${input.course}::uuid, ${input.submission}::uuid, ${input.captions}::uuid[]) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}

/** Devuelve lo enviado (`private.review_return()`). Devuelve lo que contestó, sin juzgarlo. */
export async function askReturn(tx: Tx, input: CourseReturn): Promise<string> {
  const [row] = await tx.query(
    sql`select private.review_return(${input.course}::uuid, ${input.submission}::uuid, ${input.reason}::text, ${input.whatToFix}::text) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}
