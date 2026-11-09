import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asUser, type Tx } from "@/adapters/supabase/db";
import { resolveAccountAccess } from "@/domain/access/account-access";
import { commentAllows, resolveCommentAccess, type AccountRefusal, type CommentAccess, type CommentLevel } from "@/domain/access/media-access";
import { parseCommentBody, parsePseudonym, type CommentTextResult } from "@/domain/comments/comment-text";

import { checkSession, type SessionCheck } from "@/services/account/account";
import { reportFailure, type FailureCode } from "@/services/error-reporting/server";
import { readCommentFacts, type CommentFacts } from "@/services/media/records";

import {
  deleteComment,
  editComment,
  isCommentId,
  isCommentInstant,
  postComment,
  readCanWrite,
  readCommentLesson,
  readCommentReplies,
  readLessonComments,
  readMyComments,
  readTeacherCommentCourses,
  readTeacherComments,
  setPseudonym,
  type CommentCursor,
  type CommentPage,
  type CommentThread,
  type GateRefusal,
  type LessonCommentsRow,
  type MyComment,
  type MyCommentsRow,
  type PseudonymRow,
  type TeacherCommentsRow,
  type TeacherThread,
  type RepliesRow,
  type WriteRow,
} from "./records";

// Los comentarios por lección (T-501; RF-801, RF-609, RF-808; FL-15). La base no mira el acceso (RN-01): lo decide aquí la
// regla única, con los hechos de la base y su hora, en la misma transacción en que se llama a la base, como el latido. Cada
// entrada pide su nivel: leer una lección, sus respuestas y si se puede escribir piden poder leer; publicar, escribir en esa
// lección; editar, escribir en la lección que la base dice que es la del comentario, nunca en la del formulario. Borrar lo
// propio y elegir el seudónimo piden solo la sesión, y la base mira la cuenta y el veto. Borrar pide el id y la revisión: para
// que quien perdió el acceso llegue a lo suyo, «Mis comentarios» (PA-24, `/cuenta/comentarios`; decisión de Sergio del
// 2026-11-08) lee lo propio, también solo con la sesión: la base da solo lo de quien actúa. Las lecturas reciben las claims que
// la guarda de la página ya dio; las escrituras corren la guarda.
//
// Se acepta, como en el latido, que los hechos se lean sin candado: una suscripción que vence justo entonces deja pasar
// un comentario (decisión mía sin confirmar).

export type { CommentCursor, CommentPage, CommentThread, CommentView, GateRefusal, MyComment, TeacherThread } from "./records";

/** Lo que contestó la regla cuando no alcanzó, dicho para la pantalla. */
export type AccessRefusal =
  | { kind: "not_found" }
  | { kind: "suspended_account" }
  /** El curso abierto sin suscripción: lee y no escribe (FL-15 E1). */
  | { kind: "read_only" }
  /** Sin acceso, con el motivo de la cuenta (PA-33). */
  | { kind: "no_access"; account: AccountRefusal }
  | { kind: "unavailable" };

/** Si quien mira puede escribir en la lección: el portón, o lo que contestó la regla. */
export type WriteStanding = { kind: "ok" } | { kind: "gate"; answer: GateRefusal } | AccessRefusal;

export type LessonCommentsAnswer =
  | {
      kind: "ready";
      items: CommentThread[];
      /** Desde dónde sigue la página siguiente; nulo si no hay más. */
      next: string | null;
      /** Lo publicado que todos ven, para el número de la pestaña. */
      count: number;
      me: { teacher: boolean; pseudonym: string | null };
      write: WriteStanding;
    }
  | { kind: "closed" }
  | AccessRefusal;

export type RepliesAnswer = ({ kind: "ready"; next: string | null } & Pick<CommentPage, "items">) | { kind: "closed" } | AccessRefusal;

/** Lo que contesta publicar o editar. Lo que no pasa la guarda sale tal cual: no se escribió nada. */
export type CommentWrite =
  | { kind: "written"; id: string; state: "published" | "in_review" }
  | { kind: "gate"; answer: GateRefusal }
  | { kind: "bad_parent" }
  | { kind: "throttled" }
  | { kind: "changed" }
  | { kind: "invalid"; reason: Exclude<CommentTextResult, { ok: true }>["reason"] }
  | { kind: "session"; check: SessionCheck }
  | AccessRefusal;

export type CommentDelete = { kind: "deleted" } | { kind: "not_found" } | { kind: "changed" } | { kind: "session"; check: SessionCheck } | { kind: "unavailable" };

export type PseudonymChange =
  | { kind: "saved"; pseudonym: string }
  | { kind: "closed" }
  | { kind: "suspended_account" }
  | { kind: "banned" }
  | { kind: "invalid"; reason: Exclude<CommentTextResult, { ok: true }>["reason"] }
  | { kind: "session"; check: SessionCheck }
  | { kind: "unavailable" };

/** «Mis comentarios» (PA-24): una página de lo propio y desde dónde sigue la siguiente. */
export type MyCommentsAnswer = { kind: "ready"; items: MyComment[]; next: string | null } | { kind: "unavailable" };

/**
 * PA-45: una página de lo de las lecciones del maestro, desde dónde sigue, y lo que contesta el portón al maestro (nulo sin
 * comentarios): con «ok» se ofrece responder.
 */
export type TeacherCommentsAnswer =
  | { kind: "ready"; items: TeacherThread[]; next: string | null; write: "ok" | GateRefusal | null }
  | { kind: "closed" }
  /** Dejó de ser maestro (o su cuenta se suspendió) entre la guarda y la lectura. */
  | { kind: "not_teacher" }
  | { kind: "unavailable" };

export type TeacherCoursesAnswer = { kind: "ready"; courses: { id: string; title: string }[] } | { kind: "unavailable" };

/** Lo que corrió con el acceso decidido, o la respuesta de la regla si no alcanzó. */
export type Guarded<T> = { kind: "refused"; access: CommentAccess } | { kind: "ran"; value: T };

export interface CommentsStore {
  lesson(claims: VerifiedClaims, lessonId: string, before: CommentCursor | null): Promise<Guarded<{ comments: LessonCommentsRow; canWrite: "ok" | GateRefusal | null }>>;
  replies(claims: VerifiedClaims, lessonId: string, parentId: string, after: CommentCursor | null): Promise<Guarded<RepliesRow>>;
  post(claims: VerifiedClaims, input: { lessonId: string; parentId: string | null; body: string }): Promise<Guarded<WriteRow>>;
  /** `missing`: no es un comentario propio sin borrar. */
  edit(claims: VerifiedClaims, input: { commentId: string; body: string; revision: number }): Promise<Guarded<WriteRow> | { kind: "missing" }>;
  remove(claims: VerifiedClaims, input: { commentId: string; revision: number }): Promise<"ok" | "not_found" | "changed">;
  pseudonym(claims: VerifiedClaims, pseudonym: string): Promise<PseudonymRow>;
  /** Lo propio de quien actúa, sin la regla: es su privacidad, como borrar. */
  mine(claims: VerifiedClaims, before: CommentCursor | null): Promise<MyCommentsRow>;
  /** PA-45, sin la regla: la base acota al maestro de quien actúa; el portón, con la lección del primer comentario. */
  teacher(claims: VerifiedClaims, input: { course: string | null; unanswered: boolean; before: CommentCursor | null }): Promise<{ comments: TeacherCommentsRow; canWrite: "ok" | GateRefusal | null }>;
  /** Los cursos del filtro de PA-45, como la persona. */
  teacherCourses(claims: VerifiedClaims): Promise<{ id: string; title: string }[]>;
}

/**
 * La regla única con los hechos de la base a su hora: la misma de ver, sin video (RN-01, RF-309). Hechos que la base no
 * reconoce son «no se supo».
 */
const decideComment = (facts: CommentFacts | null): CommentAccess =>
  facts === null
    ? { ok: false, reason: "unknown" }
    : resolveCommentAccess(facts.viewer, resolveAccountAccess(facts.account, facts.now, { graceDays: facts.graceDays }), facts.lesson);

/** Lee los hechos, decide, y corre `run` solo si alcanza: todo en la transacción `tx`. */
async function guarded<T>(tx: Tx, lessonId: string, needed: CommentLevel, run: (access: CommentAccess) => Promise<T>): Promise<Guarded<T>> {
  const access = decideComment(await readCommentFacts(tx, lessonId));
  if (!commentAllows(access, needed)) return { kind: "refused", access };
  return { kind: "ran", value: await run(access) };
}

/** El cursor como viaja en la dirección: `<instante>_<id>`. Uno que no tiene forma no llega a la base. */
export function parseCommentCursor(text: string | null | undefined): CommentCursor | null {
  if (typeof text !== "string" || text.length > 80) return null;
  const at = text.slice(0, text.lastIndexOf("_"));
  const id = text.slice(text.lastIndexOf("_") + 1);
  return isCommentInstant(at) && isCommentId(id) ? { at, id } : null;
}

const cursorOf = (page: { items: { createdAt: string; id: string }[]; more: boolean }): string | null => {
  const last = page.items.at(-1);
  return page.more && last ? `${last.createdAt}_${last.id}` : null;
};

const REVISION_MAX = Number.MAX_SAFE_INTEGER;
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= REVISION_MAX;

export function createComments(deps: { store: CommentsStore; checkSession: (reader: CookieReader) => Promise<SessionCheck>; report: (code: FailureCode) => Promise<void> }) {
  /** Lo que contestó la regla, dicho para la pantalla. «No se supo» se reporta. */
  async function refusalOf(access: CommentAccess): Promise<AccessRefusal> {
    if (access.ok) return { kind: "read_only" };
    switch (access.reason) {
      case "not_found":
        return { kind: "not_found" };
      case "suspended":
        return { kind: "suspended_account" };
      case "no_access":
        return { kind: "no_access", account: access.account };
      case "unknown":
        await deps.report("comments_unavailable");
        return { kind: "unavailable" };
    }
  }

  async function unavailable(): Promise<{ kind: "unavailable" }> {
    await deps.report("comments_unavailable");
    return { kind: "unavailable" };
  }

  /** Los comentarios de una lección para quien trae esas claims, desde `before` (PA-22). */
  async function lessonComments(claims: VerifiedClaims, lessonId: string, before: string | null): Promise<LessonCommentsAnswer> {
    if (!isCommentId(lessonId)) return { kind: "not_found" };
    let answer: Awaited<ReturnType<CommentsStore["lesson"]>>;
    try {
      answer = await deps.store.lesson(claims, lessonId, parseCommentCursor(before));
    } catch {
      return unavailable();
    }
    if (answer.kind === "refused") return refusalOf(answer.access);
    const { comments, canWrite } = answer.value;
    // La regla dio la lección y la base no: no deberían contradecirse, y si lo hacen, manda la base y alguien lo tiene que saber.
    if (comments.answer === "not_found") await deps.report("comments_unavailable");
    if (comments.answer !== "ok") return { kind: comments.answer };
    return {
      kind: "ready",
      items: comments.items,
      next: cursorOf(comments),
      count: comments.count,
      me: comments.me,
      write: canWrite === null ? { kind: "read_only" } : canWrite === "ok" ? { kind: "ok" } : { kind: "gate", answer: canWrite },
    };
  }

  /** Más respuestas de un comentario de esa lección, después de `after`. */
  async function commentReplies(claims: VerifiedClaims, lessonId: string, parentId: string, after: string | null): Promise<RepliesAnswer> {
    if (!isCommentId(lessonId) || !isCommentId(parentId)) return { kind: "not_found" };
    let answer: Awaited<ReturnType<CommentsStore["replies"]>>;
    try {
      answer = await deps.store.replies(claims, lessonId, parentId, parseCommentCursor(after));
    } catch {
      return unavailable();
    }
    if (answer.kind === "refused") return refusalOf(answer.access);
    const page = answer.value;
    if (page.answer !== "ok") return { kind: page.answer };
    return { kind: "ready", items: page.items, next: cursorOf(page) };
  }

  /**
   * Lo que contestó la base al escribir, o la regla si no alcanzó. Al publicar, `not_found` es el portón contradiciendo a la
   * regla, y se reporta; al editar es también el comentario que se borró en otra pestaña, y no.
   */
  async function writeOf(answer: Guarded<WriteRow>, entry: "post" | "edit"): Promise<CommentWrite> {
    if (answer.kind === "refused") return refusalOf(answer.access);
    const row = answer.value;
    switch (row.answer) {
      case "ok":
        return { kind: "written", id: row.id, state: row.state };
      case "not_found":
        if (entry === "post") await deps.report("comments_unavailable");
        return { kind: "not_found" };
      case "invalid":
        return { kind: "invalid", reason: "invalid" };
      case "bad_parent":
      case "throttled":
      case "changed":
        return { kind: row.answer };
      default:
        return { kind: "gate", answer: row.answer };
    }
  }

  /** Corre la guarda y `write` a nombre de la sesión que pasó. Lo que falla de la base se reporta. */
  async function withSession<T>(reader: CookieReader, write: (claims: VerifiedClaims) => Promise<T>): Promise<T | { kind: "session"; check: SessionCheck } | { kind: "unavailable" }> {
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    try {
      return await write(check.claims);
    } catch {
      return unavailable();
    }
  }

  /** Publica un comentario o una respuesta (FL-15, FL-38). */
  async function postLessonComment(reader: CookieReader, input: { lessonId: string; parentId: string | null; body: string | null }): Promise<CommentWrite> {
    if (!isCommentId(input.lessonId) || (input.parentId !== null && !isCommentId(input.parentId))) return { kind: "not_found" };
    const body = parseCommentBody(input.body);
    if (!body.ok) return { kind: "invalid", reason: body.reason };
    const lessonId = input.lessonId;
    const parentId = input.parentId;
    return withSession(reader, async (claims) => writeOf(await deps.store.post(claims, { lessonId, parentId, body: body.text }), "post"));
  }

  /** Edita un comentario propio, con la revisión que se vio (FL-15 paso 8). */
  async function editLessonComment(reader: CookieReader, input: { commentId: string; body: string | null; revision: number }): Promise<CommentWrite> {
    if (!isCommentId(input.commentId) || !isRevision(input.revision)) return { kind: "not_found" };
    const body = parseCommentBody(input.body);
    if (!body.ok) return { kind: "invalid", reason: body.reason };
    const { commentId, revision } = input;
    return withSession(reader, async (claims) => {
      const answer = await deps.store.edit(claims, { commentId, body: body.text, revision });
      return answer.kind === "missing" ? { kind: "not_found" } : writeOf(answer, "edit");
    });
  }

  /** Borra un comentario propio, con la revisión que se vio. Lo propio siempre se borra. */
  async function deleteLessonComment(reader: CookieReader, input: { commentId: string; revision: number }): Promise<CommentDelete> {
    if (!isCommentId(input.commentId) || !isRevision(input.revision)) return { kind: "not_found" };
    const { commentId, revision } = input;
    return withSession(reader, async (claims) => {
      const answer = await deps.store.remove(claims, { commentId, revision });
      return answer === "ok" ? { kind: "deleted" } : { kind: answer };
    });
  }

  /** Elige o cambia el seudónimo (RF-808, FL-15 paso 3). */
  async function chooseCommentName(reader: CookieReader, input: string | null): Promise<PseudonymChange> {
    const name = parsePseudonym(input);
    if (!name.ok) return { kind: "invalid", reason: name.reason };
    return withSession(reader, async (claims) => {
      const answer = await deps.store.pseudonym(claims, name.text);
      return answer.answer === "ok" ? { kind: "saved", pseudonym: answer.pseudonym } : answer.answer === "invalid" ? { kind: "invalid", reason: "invalid" } : { kind: answer.answer };
    });
  }

  /**
   * Lo propio de quien trae esas claims (PA-24), desde `before`: sin la regla de acceso, porque es para borrar lo suyo también
   * sin acceso. La base solo da lo de quien actúa; si no supo quién (no debería pasar con una sesión), «no se supo».
   */
  async function myComments(claims: VerifiedClaims, before: string | null): Promise<MyCommentsAnswer> {
    let page: MyCommentsRow;
    try {
      page = await deps.store.mine(claims, parseCommentCursor(before));
    } catch {
      return unavailable();
    }
    if (page.answer !== "ok") return unavailable();
    return { kind: "ready", items: page.items, next: cursorOf(page) };
  }

  /**
   * PA-45 (RF-609): lo de las lecciones del maestro de quien trae esas claims, con las claims que dio la guarda del portal. Sin la
   * regla de acceso (decisión de Sergio del 2026-11-08): para el dueño de la lección, la regla se reduce a lo que acota la base, y
   * la integración 104 exige que coincidan. Un curso o un cursor sin forma no llegan a la base.
   */
  async function teacherComments(claims: VerifiedClaims, input: { course: string | null; unanswered: boolean; before: string | null }): Promise<TeacherCommentsAnswer> {
    let answer: Awaited<ReturnType<CommentsStore["teacher"]>>;
    try {
      answer = await deps.store.teacher(claims, {
        course: isCommentId(input.course) ? input.course : null,
        unanswered: input.unanswered,
        before: parseCommentCursor(input.before),
      });
    } catch {
      return unavailable();
    }
    const { comments, canWrite } = answer;
    if (comments.answer !== "ok") return { kind: comments.answer };
    return { kind: "ready", items: comments.items, next: cursorOf(comments), write: canWrite };
  }

  /** Los cursos del filtro de PA-45. */
  async function teacherCommentCourses(claims: VerifiedClaims): Promise<TeacherCoursesAnswer> {
    try {
      return { kind: "ready", courses: await deps.store.teacherCourses(claims) };
    } catch {
      return unavailable();
    }
  }

  return { lessonComments, commentReplies, postLessonComment, editLessonComment, deleteLessonComment, chooseCommentName, myComments, teacherComments, teacherCommentCourses };
}

/** Una transacción como servidor a nombre de esas claims. La integración 102 pasa una del dueño que se revierte. */
export type RunAsServer = <T>(claims: VerifiedClaims, reason: string, work: (tx: Tx) => Promise<T>) => Promise<T>;
/** Una transacción como la persona (solo los cursos del filtro de PA-45). */
export type RunAsUser = <T>(claims: VerifiedClaims, work: (tx: Tx) => Promise<T>) => Promise<T>;

/** Sin lector como la persona: como servidor, `current_teacher_id` no ve la sesión y la lista saldría vacía sin fallar. */
const noUserReads: RunAsUser = () => Promise.reject(new Error("este almacén no lee como la persona"));

/**
 * Todo como servidor, a nombre de quien actúa: nadie de la aplicación lee ni escribe las tablas, solo las funciones. Cada
 * entrada decide el acceso y llama a la base en la misma transacción.
 */
export function commentsStoreOn(run: RunAsServer, read: RunAsUser = noUserReads): CommentsStore {
  return {
    lesson: (claims, lessonId, before) =>
      run(claims, "comments_read", (tx) =>
        guarded(tx, lessonId, "read", async (access) => ({
          comments: await readLessonComments(tx, lessonId, before),
          canWrite: commentAllows(access, "write") ? await readCanWrite(tx, lessonId) : null,
        })),
      ),
    replies: (claims, lessonId, parentId, after) =>
      run(claims, "comments_read", (tx) => guarded(tx, lessonId, "read", () => readCommentReplies(tx, lessonId, parentId, after))),
    post: (claims, input) => run(claims, "comment_post", (tx) => guarded(tx, input.lessonId, "write", () => postComment(tx, input))),
    edit: (claims, input) =>
      run(claims, "comment_edit", async (tx) => {
        const lessonId = await readCommentLesson(tx, input.commentId);
        return lessonId === null ? { kind: "missing" as const } : guarded(tx, lessonId, "write", () => editComment(tx, input));
      }),
    remove: (claims, input) => run(claims, "comment_delete", (tx) => deleteComment(tx, input)),
    pseudonym: (claims, pseudonym) => run(claims, "comment_pseudonym", (tx) => setPseudonym(tx, pseudonym)),
    mine: (claims, before) => run(claims, "comments_mine", (tx) => readMyComments(tx, before)),
    teacher: (claims, input) =>
      run(claims, "comments_teacher", async (tx) => {
        const comments = await readTeacherComments(tx, input);
        const first = comments.answer === "ok" ? comments.items[0] : undefined;
        return { comments, canWrite: first === undefined ? null : await readCanWrite(tx, first.lessonId) };
      }),
    teacherCourses: (claims) => read(claims, (tx) => readTeacherCommentCourses(tx)),
  };
}

export const databaseCommentsStore = commentsStoreOn((claims, reason, work) => asServer({ claims, reason }, work), asUser);

export const {
  lessonComments,
  commentReplies,
  postLessonComment,
  editLessonComment,
  deleteLessonComment,
  chooseCommentName,
  myComments,
  teacherComments,
  teacherCommentCourses,
} = createComments({
  store: databaseCommentsStore,
  checkSession,
  report: reportFailure,
});
