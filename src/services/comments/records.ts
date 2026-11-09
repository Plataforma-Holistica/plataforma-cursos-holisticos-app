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
    state: z.enum(["published", "in_review", "deleted"]),
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
  state: "published" | "in_review" | "deleted";
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

// ---------------------------------------------------------------------------------------
// Escribir.

const written = z.object({ answer: z.literal("ok"), id: z.string().regex(ID), state: z.enum(["published", "in_review"]) }).strict();

export type WriteRow = { answer: "ok"; id: string; state: "published" | "in_review" } | { answer: GateRefusal | "invalid" | "bad_parent" | "throttled" | "changed" };

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

const editAnswer = z.union([written, answerOnly([...GATE_REFUSALS, "invalid", "throttled", "changed"])]);

/** Edita un comentario propio, con la revisión que se vio. */
export async function editComment(tx: Tx, input: { commentId: string; body: string; revision: number }): Promise<WriteRow> {
  const [row] = await tx.query(
    sql`select private.comment_edit(${input.commentId}::uuid, ${input.body}, ${input.revision}::bigint) as answer`,
    z.object({ answer: editAnswer }),
  );
  if (!row) throw new Error("comment_edit no contestó");
  return row.answer;
}

const deleteAnswer = answerOnly(["ok", "not_found", "changed"]);

/** Borra un comentario propio, con la revisión que se vio. Lo propio siempre se borra. */
export async function deleteComment(tx: Tx, input: { commentId: string; revision: number }): Promise<"ok" | "not_found" | "changed"> {
  const [row] = await tx.query(
    sql`select private.comment_delete(${input.commentId}::uuid, ${input.revision}::bigint) as answer`,
    z.object({ answer: deleteAnswer }),
  );
  if (!row) throw new Error("comment_delete no contestó");
  return row.answer.answer;
}

const pseudonymAnswer = z.union([
  z.object({ answer: z.literal("ok"), pseudonym: z.string() }).strict(),
  answerOnly(["closed", "suspended_account", "banned", "invalid"]),
]);

export type PseudonymRow = { answer: "ok"; pseudonym: string } | { answer: "closed" | "suspended_account" | "banned" | "invalid" };

/** Elige o cambia el seudónimo de quien actúa. */
export async function setPseudonym(tx: Tx, pseudonym: string): Promise<PseudonymRow> {
  const [row] = await tx.query(sql`select private.comment_set_pseudonym(${pseudonym}) as answer`, z.object({ answer: pseudonymAnswer }));
  if (!row) throw new Error("comment_set_pseudonym no contestó");
  return row.answer;
}
