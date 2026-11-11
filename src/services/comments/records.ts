import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

// Lo que el servicio de comentarios le pregunta a la base (T-501). El único archivo que nombra las funciones
// `private.comment*`: una prueba de arquitectura lo exige. Cada función recibe la transacción ya abierta, en la que el
// servidor ya decidió el acceso con la regla única (`comments.ts`). Las respuestas se leen con objetos estrictos: una clave
// que no se conoce es «no se supo».

/** El instante de un comentario, como lo da la base: con microsegundos. Viaja como texto, nunca por un `Date`. */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isCommentId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** Con un día que existe: `Date.parse` acepta el 30 de febrero, y la base lo rechaza al convertirlo. */
export function isCommentInstant(value: unknown): value is string {
  const parts = typeof value === "string" ? INSTANT.exec(value) : null;
  if (parts === null) return false;
  const [year, month, day, hour, minute, second, offsetHour = 0, offsetMinute = 0] = parts.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    year! >= 1 &&
    date.getUTCFullYear() === year && // Date.UTC lee 0 a 99 como 1900 a 1999: así no pasan
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day &&
    hour! < 24 &&
    minute! < 60 &&
    second! < 60 &&
    offsetHour! < 16 &&
    offsetMinute! < 60
  );
}

/** Desde dónde sigue una página: el comentario que se vio al último. */
export interface CommentCursor {
  at: string;
  id: string;
}

const viewRow = z
  .object({
    id: z.string().regex(ID),
    name: z.string().nullable(),
    body: z.string().nullable(),
    state: z.enum(["published", "in_review", "deleted", "hidden"]),
    own: z.boolean(),
    teacher: z.boolean(),
    edited: z.boolean(),
    created_at: z.string().refine(isCommentInstant),
    revision: z.number().int().positive().nullable(),
  })
  .strict();

/** Un comentario o una respuesta, como lo ve quien mira. `revision` solo en lo propio: es lo que llevan editar y borrar. */
export interface CommentView {
  id: string;
  name: string | null;
  body: string | null;
  /** `hidden`: oculto por reportes (T-502). Para quien no es su autor, sin texto ni nombre. */
  state: "published" | "in_review" | "deleted" | "hidden";
  own: boolean;
  teacher: boolean;
  edited: boolean;
  createdAt: string;
  revision: number | null;
}

export interface CommentPage {
  items: CommentView[];
  more: boolean;
}

export interface CommentThread extends CommentView {
  replies: CommentPage;
}

const viewOf = (row: z.infer<typeof viewRow>): CommentView => ({
  id: row.id,
  name: row.name,
  body: row.body,
  state: row.state,
  own: row.own,
  teacher: row.teacher,
  edited: row.edited,
  createdAt: row.created_at,
  revision: row.revision,
});

const pageRow = z.object({ items: z.array(viewRow), more: z.boolean() }).strict();
const pageOf = (row: z.infer<typeof pageRow>): CommentPage => ({ items: row.items.map(viewOf), more: row.more });

const closed = z.object({ answer: z.literal("closed") }).strict();
const notFound = z.object({ answer: z.literal("not_found") }).strict();
const answerOnly = <T extends string>(answers: readonly [T, ...T[]]) => z.object({ answer: z.enum(answers) }).strict();

/** Lo que contesta el portón de escribir (`comment_gate`), salvo que pase. */
export const GATE_REFUSALS = ["closed", "suspended_account", "not_found", "banned", "suspended", "needs_notice", "needs_pseudonym"] as const;
export type GateRefusal = (typeof GATE_REFUSALS)[number];

// ---------------------------------------------------------------------------------------
// Leer.

const lessonAnswer = z.union([
  closed,
  notFound,
  z
    .object({
      answer: z.literal("ok"),
      items: z.array(viewRow.extend({ replies: pageRow }).strict()),
      more: z.boolean(),
      count: z.number().int().nonnegative(),
      me: z.object({ teacher: z.boolean(), pseudonym: z.string().nullable() }).strict(),
    })
    .strict(),
]);

export type LessonCommentsRow =
  | { answer: "closed" | "not_found" }
  | { answer: "ok"; items: CommentThread[]; more: boolean; count: number; me: { teacher: boolean; pseudonym: string | null } };

/** Los comentarios de una lección para quien actúa, del más reciente al más antiguo, desde `before`. */
export async function readLessonComments(tx: Tx, lessonId: string, before: CommentCursor | null): Promise<LessonCommentsRow> {
  const [row] = await tx.query(
    sql`select private.comments_for_lesson(${lessonId}::uuid, ${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid) as answer`,
    z.object({ answer: lessonAnswer }),
  );
  if (!row) throw new Error("comments_for_lesson no contestó");
  const answer = row.answer;
  if (answer.answer !== "ok") return { answer: answer.answer };
  return {
    answer: "ok",
    items: answer.items.map(({ replies, ...view }) => ({ ...viewOf(view), replies: pageOf(replies) })),
    more: answer.more,
    count: answer.count,
    me: answer.me,
  };
}

const repliesAnswer = z.union([closed, notFound, pageRow.extend({ answer: z.literal("ok") }).strict()]);

export type RepliesRow = { answer: "closed" | "not_found" } | ({ answer: "ok" } & CommentPage);

/** Más respuestas de un comentario de esa lección, después de `after`. */
export async function readCommentReplies(tx: Tx, lessonId: string, parentId: string, after: CommentCursor | null): Promise<RepliesRow> {
  const [row] = await tx.query(
    sql`select private.comment_replies(${lessonId}::uuid, ${parentId}::uuid, ${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid) as answer`,
    z.object({ answer: repliesAnswer }),
  );
  if (!row) throw new Error("comment_replies no contestó");
  const answer = row.answer;
  return answer.answer === "ok" ? { answer: "ok", ...pageOf(answer) } : { answer: answer.answer };
}

const canWriteAnswer = answerOnly(["ok", ...GATE_REFUSALS]);

/** Lo que contestaría el portón a quien actúa en esa lección, sin escribir ni contar el freno. */
export async function readCanWrite(tx: Tx, lessonId: string): Promise<"ok" | GateRefusal> {
  const [row] = await tx.query(sql`select private.comment_can_write(${lessonId}::uuid) as answer`, z.object({ answer: canWriteAnswer }));
  if (!row) throw new Error("comment_can_write no contestó");
  return row.answer.answer;
}

/** La lección de un comentario propio sin borrar, o nulo. Con ella, y nunca con la del formulario, se decide editar. */
export async function readCommentLesson(tx: Tx, commentId: string): Promise<string | null> {
  const [row] = await tx.query(sql`select private.comment_lesson_of(${commentId}::uuid) as lesson`, z.object({ lesson: z.string().regex(ID).nullable() }));
  return row?.lesson ?? null;
}

const mineRow = z
  .object({
    id: z.string().regex(ID),
    revision: z.number().int().positive(),
    body: z.string(),
    state: z.enum(["published", "in_review"]),
    edited: z.boolean(),
    created_at: z.string().refine(isCommentInstant),
    is_reply: z.boolean(),
    course_title: z.string(),
    lesson_title: z.string(),
    course_slug: z.string().nullable(),
    lesson_id: z.string().regex(ID).nullable(),
  })
  .strict()
  // El enlace va entero o no va: los dos, solo si la lección se ve.
  .refine((row) => (row.course_slug === null) === (row.lesson_id === null));

/** Un comentario propio en «Mis comentarios» (PA-24): sin nada de nadie más. `link`, solo si la lección se ve. */
export interface MyComment {
  id: string;
  revision: number;
  body: string;
  state: "published" | "in_review";
  edited: boolean;
  createdAt: string;
  isReply: boolean;
  courseTitle: string;
  lessonTitle: string;
  link: { slug: string; lessonId: string } | null;
}

const mineAnswer = z.union([notFound, z.object({ answer: z.literal("ok"), items: z.array(mineRow), more: z.boolean() }).strict()]);

export type MyCommentsRow = { answer: "not_found" } | { answer: "ok"; items: MyComment[]; more: boolean };

/** Lo propio de quien actúa, sin lo borrado ni lo oculto, del más reciente al más antiguo, desde `before`. */
export async function readMyComments(tx: Tx, before: CommentCursor | null): Promise<MyCommentsRow> {
  const [row] = await tx.query(
    sql`select private.comments_of_author(${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid) as answer`,
    z.object({ answer: mineAnswer }),
  );
  if (!row) throw new Error("comments_of_author no contestó");
  const answer = row.answer;
  if (answer.answer !== "ok") return { answer: answer.answer };
  return {
    answer: "ok",
    more: answer.more,
    items: answer.items.map((item) => ({
      id: item.id,
      revision: item.revision,
      body: item.body,
      state: item.state,
      edited: item.edited,
      createdAt: item.created_at,
      isReply: item.is_reply,
      courseTitle: item.course_title,
      lessonTitle: item.lesson_title,
      link: item.course_slug !== null && item.lesson_id !== null ? { slug: item.course_slug, lessonId: item.lesson_id } : null,
    })),
  };
}

// PA-45: lo de las lecciones del maestro de quien actúa, cada comentario con su lección, su curso y si ya respondió.
const teacherRow = viewRow
  .extend({
    lesson: z.string().regex(ID),
    lesson_title: z.string(),
    course: z.string().regex(ID),
    course_title: z.string(),
    course_slug: z.string(),
    answered: z.boolean(),
    replies: pageRow,
  })
  .strict();

/** Un comentario de PA-45: el de la lección, con dónde está y si el maestro ya respondió. */
export interface TeacherThread extends CommentThread {
  lessonId: string;
  lessonTitle: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  answered: boolean;
}

const teacherAnswer = z.union([closed, answerOnly(["not_teacher"]), z.object({ answer: z.literal("ok"), items: z.array(teacherRow), more: z.boolean() }).strict()]);

export type TeacherCommentsRow = { answer: "closed" | "not_teacher" } | { answer: "ok"; items: TeacherThread[]; more: boolean };

/** Lo de las lecciones del maestro de quien actúa, de un curso o de todos, todo o lo sin responder, desde `before`. */
export async function readTeacherComments(tx: Tx, input: { course: string | null; unanswered: boolean; before: CommentCursor | null }): Promise<TeacherCommentsRow> {
  const [row] = await tx.query(
    sql`select private.comments_for_teacher(${input.course}::uuid, ${input.unanswered}, ${input.before?.at ?? null}::timestamptz, ${input.before?.id ?? null}::uuid) as answer`,
    z.object({ answer: teacherAnswer }),
  );
  if (!row) throw new Error("comments_for_teacher no contestó");
  const answer = row.answer;
  if (answer.answer !== "ok") return { answer: answer.answer };
  return {
    answer: "ok",
    more: answer.more,
    items: answer.items.map(({ replies, lesson, lesson_title, course, course_title, course_slug, answered, ...view }) => ({
      ...viewOf(view),
      replies: pageOf(replies),
      lessonId: lesson,
      lessonTitle: lesson_title,
      courseId: course,
      courseTitle: course_title,
      courseSlug: course_slug,
      answered,
    })),
  };
}

const courseChoice = z.object({ course_id: z.string().regex(ID), title: z.string() }).strict();

/**
 * Los cursos del filtro de PA-45, como la persona: los de su maestro (también suspendido) que se ven, publicados o con una versión
 * abierta y listados, con el título publicado, que es el que llevan sus comentarios. No nombra las tablas de comentarios.
 */
export async function readTeacherCommentCourses(tx: Tx): Promise<{ id: string; title: string }[]> {
  const rows = await tx.query(
    sql`select p.course_id, p.title
        from public.course_registry r
        join public.published_courses p on p.course_id = r.course_id and p.is_listed
        where r.teacher_id = (select private.current_teacher_id()) and r.state in ('published', 'changes_pending')
        order by p.title, p.course_id`,
    courseChoice,
  );
  return rows.map((row) => ({ id: row.course_id, title: row.title }));
}

// ---------------------------------------------------------------------------------------
// Escribir.

// Publicar y editar dejan el texto en el filtro (T-502): `in_filter` espera el veredicto del proveedor, que se asienta después
// con su revisión; `in_review` es lo que la lista de la base marcó ahí mismo.
const written = z
  .object({ answer: z.literal("ok"), id: z.string().regex(ID), revision: z.number().int().min(1), state: z.enum(["published", "in_review", "in_filter"]) })
  .strict();

export type WriteRow =
  | { answer: "ok"; id: string; revision: number; state: "published" | "in_review" | "in_filter" }
  | { answer: GateRefusal | "invalid" | "bad_parent" | "throttled" | "changed" | "hidden" };

const postAnswer = z.union([written, answerOnly([...GATE_REFUSALS, "invalid", "bad_parent", "throttled"])]);

/** Publica un comentario o una respuesta a nombre de quien actúa. */
export async function postComment(tx: Tx, input: { lessonId: string; parentId: string | null; body: string }): Promise<WriteRow> {
  const [row] = await tx.query(
    sql`select private.comment_post(${input.lessonId}::uuid, ${input.parentId}::uuid, ${input.body}) as answer`,
    z.object({ answer: postAnswer }),
  );
  if (!row) throw new Error("comment_post no contestó");
  return row.answer;
}

const editAnswer = z.union([written, answerOnly([...GATE_REFUSALS, "invalid", "throttled", "changed", "hidden"])]);

/** Edita un comentario propio, con la revisión que se vio. */
export async function editComment(tx: Tx, input: { commentId: string; body: string; revision: number }): Promise<WriteRow> {
  const [row] = await tx.query(
    sql`select private.comment_edit(${input.commentId}::uuid, ${input.body}, ${input.revision}::bigint) as answer`,
    z.object({ answer: editAnswer }),
  );
  if (!row) throw new Error("comment_edit no contestó");
  return row.answer;
}

// El veredicto del proveedor, de vuelta (T-502). `stale`: el comentario ya no está en el filtro con esa revisión (se editó
// otra vez, o lo tomó el barrido), y dice cómo quedó.
const settleAnswer = z.union([
  z.object({ answer: z.enum(["ok", "stale"]), state: z.enum(["published", "in_review"]) }).strict(),
  answerOnly(["not_found", "invalid"]),
]);

export type SettleRow = { answer: "ok" | "stale"; state: "published" | "in_review" } | { answer: "not_found" | "invalid" };

/** Asienta lo propio que sigue en el filtro con esa revisión, con el veredicto y el proveedor que lo dio. */
export async function settleComment(tx: Tx, input: { commentId: string; revision: number; verdict: FilterVerdict; provider: string }): Promise<SettleRow> {
  const [row] = await tx.query(
    sql`select private.comment_settle(${input.commentId}::uuid, ${input.revision}::bigint, ${input.verdict}, ${input.provider}) as answer`,
    z.object({ answer: settleAnswer }),
  );
  if (!row) throw new Error("comment_settle no contestó");
  return row.answer;
}

export type FilterVerdict = "pass" | "flagged" | "risk" | "unavailable";

const deleteAnswer = answerOnly(["ok", "not_found", "changed", "hidden"]);

/** Borra un comentario propio, con la revisión que se vio. Lo oculto espera a moderación (T-502). */
export async function deleteComment(tx: Tx, input: { commentId: string; revision: number }): Promise<"ok" | "not_found" | "changed" | "hidden"> {
  const [row] = await tx.query(
    sql`select private.comment_delete(${input.commentId}::uuid, ${input.revision}::bigint) as answer`,
    z.object({ answer: deleteAnswer }),
  );
  if (!row) throw new Error("comment_delete no contestó");
  return row.answer.answer;
}

const pseudonymAnswer = z.union([
  z.object({ answer: z.literal("ok"), pseudonym: z.string() }).strict(),
  answerOnly(["closed", "suspended_account", "banned", "invalid", "flagged", "throttled"]),
]);

export type PseudonymRow = { answer: "ok"; pseudonym: string } | { answer: "closed" | "suspended_account" | "banned" | "invalid" | "flagged" | "throttled" };

/** Elige o cambia el seudónimo de quien actúa. */
export async function setPseudonym(tx: Tx, pseudonym: string): Promise<PseudonymRow> {
  const [row] = await tx.query(sql`select private.comment_set_pseudonym(${pseudonym}) as answer`, z.object({ answer: pseudonymAnswer }));
  if (!row) throw new Error("comment_set_pseudonym no contestó");
  return row.answer;
}

// ---------------------------------------------------------------------------------------
// Reportar (T-502; RF-803).

/** La lección de un comentario publicado, para correr la regla antes de reportarlo; nula si no lo está. */
export async function readReportLesson(tx: Tx, commentId: string): Promise<string | null> {
  const [row] = await tx.query(sql`select private.comment_report_lesson(${commentId}::uuid) as lesson`, z.object({ lesson: z.string().regex(ID).nullable() }));
  return row?.lesson ?? null;
}

export const REPORT_REASONS = ["spam", "abusive", "medical_advice", "concern_for_person", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const reportAnswer = answerOnly(["ok", "already", "not_found", "invalid", "throttled", "closed", "suspended_account"]);
export type ReportRow = z.infer<typeof reportAnswer>["answer"];

/** Reporta un comentario a nombre de quien actúa; `counts` es lo que decidió la regla: si puede escribir ahí. */
export async function reportComment(tx: Tx, input: { commentId: string; reason: ReportReason; note: string | null; counts: boolean }): Promise<ReportRow> {
  const [row] = await tx.query(
    sql`select private.comment_report(${input.commentId}::uuid, ${input.reason}, ${input.note}, ${input.counts}) as answer`,
    z.object({ answer: reportAnswer }),
  );
  if (!row) throw new Error("comment_report no contestó");
  return row.answer.answer;
}
