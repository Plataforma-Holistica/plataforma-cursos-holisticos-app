import { describe, expect, it, vi } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { CommentAccess } from "@/domain/access/media-access";
import type { SessionCheck } from "@/services/account/account";

import { createComments, parseCommentCursor, type CommentsStore } from "./comments";
import type { CommentThread, LessonCommentsRow, MyCommentsRow } from "./records";

vi.mock("server-only", () => ({}));
vi.mock("@/adapters/supabase/db", () => ({ asServer: vi.fn() }));
vi.mock("@/services/account/account", () => ({ checkSession: vi.fn() }));
vi.mock("@/services/error-reporting/server", () => ({ reportFailure: vi.fn() }));

// El servicio de los comentarios (T-501), con su almacén simulado: qué llega a la base, qué se contesta y qué se reporta.
// La regla con los hechos de la base y el nivel de cada entrada, contra la base de verdad, en
// tests/integration/102-comentarios-servicio.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const reader = {} as CookieReader;
const LESSON = "b0000000-0000-4000-8000-000000000001";
const COMMENT = "c0000000-0000-4000-8000-000000000001";
const AT = "2026-11-07T20:00:00.123456+00:00";

const THREAD: CommentThread = {
  id: COMMENT,
  name: "Ana",
  body: "Hola",
  state: "published",
  own: true,
  teacher: false,
  edited: false,
  createdAt: AT,
  revision: 1,
  replies: { items: [], more: false },
};
const READY: LessonCommentsRow = { answer: "ok", items: [THREAD], more: false, count: 1, me: { teacher: false, pseudonym: "Ana" } };
const NEVER = { allowed: false, reason: "never_subscribed" } as const;
const MINE: MyCommentsRow = {
  answer: "ok",
  more: true,
  items: [
    {
      id: COMMENT,
      revision: 2,
      body: "Hola",
      state: "in_review",
      edited: true,
      createdAt: AT,
      isReply: false,
      courseTitle: "Respirar",
      lessonTitle: "Soltar",
      link: { slug: "respirar", lessonId: LESSON },
    },
  ],
};

function commentsWith(session: SessionCheck = { kind: "pass", claims }) {
  const reported: string[] = [];
  const store = {
    lesson: vi.fn<CommentsStore["lesson"]>(() => Promise.resolve({ kind: "ran", value: { comments: READY, canWrite: "ok" } })),
    replies: vi.fn<CommentsStore["replies"]>(() => Promise.resolve({ kind: "ran", value: { answer: "ok", items: [THREAD], more: true } })),
    post: vi.fn<CommentsStore["post"]>(() => Promise.resolve({ kind: "ran", value: { answer: "ok", id: COMMENT, state: "published" } })),
    edit: vi.fn<CommentsStore["edit"]>(() => Promise.resolve({ kind: "ran", value: { answer: "ok", id: COMMENT, state: "in_review" } })),
    remove: vi.fn<CommentsStore["remove"]>(() => Promise.resolve("ok")),
    pseudonym: vi.fn<CommentsStore["pseudonym"]>(() => Promise.resolve({ answer: "ok", pseudonym: "Ana" })),
    mine: vi.fn<CommentsStore["mine"]>(() => Promise.resolve(MINE)),
  } satisfies CommentsStore;
  const checkSession = vi.fn<(reader: CookieReader) => Promise<SessionCheck>>(() => Promise.resolve(session));
  const service = createComments({ store, checkSession, report: (code) => (reported.push(code), Promise.resolve()) });
  return { ...service, store, checkSession, reported };
}

const refused = (access: CommentAccess) => ({ kind: "refused" as const, access });

describe("el cursor", () => {
  it("viaja como `<instante>_<id>` y se valida antes de la base", () => {
    expect(parseCommentCursor(`${AT}_${COMMENT}`)).toEqual({ at: AT, id: COMMENT });
    expect(parseCommentCursor(`2026-11-07T20:00:00Z_${COMMENT}`)).toEqual({ at: "2026-11-07T20:00:00Z", id: COMMENT });
    for (const bad of [null, undefined, "", COMMENT, `${AT}_x`, `ayer_${COMMENT}`, `2026-13-40T20:00:00Z_${COMMENT}`, `${AT}_${COMMENT}`.repeat(2), `${AT}_${COMMENT.toUpperCase()}`]) {
      expect(parseCommentCursor(bad)).toBeNull();
    }
  });

  it("un día que no existe tampoco: `Date.parse` lo acepta y la base no", () => {
    expect(parseCommentCursor(`2028-02-29T23:59:59.999999-06:00_${COMMENT}`)).toEqual({ at: "2028-02-29T23:59:59.999999-06:00", id: COMMENT });
    for (const at of ["2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "0000-01-01T00:00:00Z", "2026-11-07T24:00:00Z", "2026-11-07T20:60:00Z", "2026-11-07T20:00:60Z", "2026-11-07T20:00:00+16:00", "2026-11-07T20:00:00+05:60"]) {
      expect(parseCommentCursor(`${at}_${COMMENT}`)).toBeNull();
    }
  });
});

describe("leer una lección", () => {
  it("pasa el cursor ya validado, y dice si quien mira puede escribir", async () => {
    const service = commentsWith();
    expect(await service.lessonComments(claims, LESSON, `${AT}_${COMMENT}`)).toEqual({
      kind: "ready",
      items: [THREAD],
      next: null,
      count: 1,
      me: { teacher: false, pseudonym: "Ana" },
      write: { kind: "ok" },
    });
    expect(service.store.lesson).toHaveBeenCalledExactlyOnceWith(claims, LESSON, { at: AT, id: COMMENT });
  });

  it("un cursor sin forma empieza por lo más reciente", async () => {
    const service = commentsWith();
    await service.lessonComments(claims, LESSON, "lo-que-sea");
    expect(service.store.lesson).toHaveBeenCalledExactlyOnceWith(claims, LESSON, null);
  });

  it("con más, la página siguiente sigue desde el último que se vio", async () => {
    const service = commentsWith();
    service.store.lesson.mockResolvedValueOnce({ kind: "ran", value: { comments: { ...READY, more: true }, canWrite: "needs_pseudonym" } });
    expect(await service.lessonComments(claims, LESSON, null)).toMatchObject({ next: `${AT}_${COMMENT}`, write: { kind: "gate", answer: "needs_pseudonym" } });
  });

  it("quien solo lee no le pregunta al portón: lo dice la regla", async () => {
    const service = commentsWith();
    service.store.lesson.mockResolvedValueOnce({ kind: "ran", value: { comments: READY, canWrite: null } });
    expect(await service.lessonComments(claims, LESSON, null)).toMatchObject({ write: { kind: "read_only" } });
  });

  it("cerrados o una lección que la base no da", async () => {
    const service = commentsWith();
    service.store.lesson.mockResolvedValueOnce({ kind: "ran", value: { comments: { answer: "closed" }, canWrite: null } });
    expect(await service.lessonComments(claims, LESSON, null)).toEqual({ kind: "closed" });
    expect(service.reported).toEqual([]);
    // La regla dio la lección y la base no: no deberían contradecirse, y si lo hacen, manda la base y alguien lo tiene que saber.
    service.store.lesson.mockResolvedValueOnce({ kind: "ran", value: { comments: { answer: "not_found" }, canWrite: null } });
    expect(await service.lessonComments(claims, LESSON, null)).toEqual({ kind: "not_found" });
    expect(service.reported).toEqual(["comments_unavailable"]);
  });

  it.each<[CommentAccess, unknown]>([
    [{ ok: false, reason: "not_found" }, { kind: "not_found" }],
    [{ ok: false, reason: "suspended" }, { kind: "suspended_account" }],
    [{ ok: false, reason: "no_access", account: NEVER }, { kind: "no_access", account: NEVER }],
  ])("lo que contesta la regla sin acceso sale tal cual, sin texto", async (access, expected) => {
    const service = commentsWith();
    service.store.lesson.mockResolvedValueOnce(refused(access));
    expect(await service.lessonComments(claims, LESSON, null)).toEqual(expected);
    expect(service.reported).toEqual([]);
  });

  it("«no se supo» de la regla o de la base se reporta", async () => {
    const service = commentsWith();
    service.store.lesson.mockResolvedValueOnce(refused({ ok: false, reason: "unknown" }));
    expect(await service.lessonComments(claims, LESSON, null)).toEqual({ kind: "unavailable" });
    service.store.lesson.mockRejectedValueOnce(new Error("sin base"));
    expect(await service.lessonComments(claims, LESSON, null)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["comments_unavailable", "comments_unavailable"]);
  });

  it("una lección sin forma no llega a la base", async () => {
    const service = commentsWith();
    expect(await service.lessonComments(claims, "lección", null)).toEqual({ kind: "not_found" });
    expect(service.store.lesson).not.toHaveBeenCalled();
  });
});

describe("más respuestas", () => {
  it("desde la última que se vio, con la siguiente", async () => {
    const service = commentsWith();
    expect(await service.commentReplies(claims, LESSON, COMMENT, null)).toEqual({ kind: "ready", items: [THREAD], next: `${AT}_${COMMENT}` });
    expect(service.store.replies).toHaveBeenCalledExactlyOnceWith(claims, LESSON, COMMENT, null);
  });

  it("de lo que no se ve, o sin acceso, nada", async () => {
    const service = commentsWith();
    service.store.replies.mockResolvedValueOnce({ kind: "ran", value: { answer: "not_found" } });
    expect(await service.commentReplies(claims, LESSON, COMMENT, null)).toEqual({ kind: "not_found" });
    service.store.replies.mockResolvedValueOnce(refused({ ok: false, reason: "no_access", account: NEVER }));
    expect(await service.commentReplies(claims, LESSON, COMMENT, null)).toEqual({ kind: "no_access", account: NEVER });
    expect(await service.commentReplies(claims, LESSON, "x", null)).toEqual({ kind: "not_found" });
    expect(service.store.replies).toHaveBeenCalledTimes(2);
  });

  it("si la base no contestó, se reporta", async () => {
    const service = commentsWith();
    service.store.replies.mockRejectedValueOnce(new Error("sin base"));
    expect(await service.commentReplies(claims, LESSON, COMMENT, null)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["comments_unavailable"]);
  });
});

describe("publicar", () => {
  it("revisa el texto, corre la guarda y publica a nombre de la sesión que pasó, con el texto normalizado", async () => {
    const service = commentsWith();
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: " Hola\r\nmundo " })).toEqual({
      kind: "written",
      id: COMMENT,
      state: "published",
    });
    expect(service.checkSession).toHaveBeenCalledExactlyOnceWith(reader);
    expect(service.store.post).toHaveBeenCalledExactlyOnceWith(claims, { lessonId: LESSON, parentId: null, body: "Hola\nmundo" });
  });

  it("un texto que no pasa no llega a la guarda ni a la base", async () => {
    const service = commentsWith();
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: "  " })).toEqual({ kind: "invalid", reason: "empty" });
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: "a\u{202e}b" })).toEqual({ kind: "invalid", reason: "invalid" });
    expect(service.checkSession).not.toHaveBeenCalled();
  });

  it("una lección o un padre sin forma tampoco", async () => {
    const service = commentsWith();
    expect(await service.postLessonComment(reader, { lessonId: "x", parentId: null, body: "Hola" })).toEqual({ kind: "not_found" });
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: "x", body: "Hola" })).toEqual({ kind: "not_found" });
    expect(service.checkSession).not.toHaveBeenCalled();
  });

  it.each<SessionCheck>([{ kind: "anonymous" }, { kind: "suspended" }, { kind: "must_sign_out", then: "sign_in" }, { kind: "unavailable" }])(
    "lo que no pasa la guarda ($kind) sale tal cual, sin escribir",
    async (check) => {
      const service = commentsWith(check);
      expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: "Hola" })).toEqual({ kind: "session", check });
      expect(service.store.post).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ answer: "closed" as const }, { kind: "gate", answer: "closed" }],
    [{ answer: "needs_pseudonym" as const }, { kind: "gate", answer: "needs_pseudonym" }],
    [{ answer: "banned" as const }, { kind: "gate", answer: "banned" }],
    [{ answer: "bad_parent" as const }, { kind: "bad_parent" }],
    [{ answer: "throttled" as const }, { kind: "throttled" }],
    [{ answer: "invalid" as const }, { kind: "invalid", reason: "invalid" }],
  ])("lo que contesta la base (%j) se dice por su nombre, sin reportarlo", async (row, expected) => {
    const service = commentsWith();
    service.store.post.mockResolvedValueOnce({ kind: "ran", value: row });
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: "Hola" })).toEqual(expected);
    expect(service.reported).toEqual([]);
  });

  it("si la regla dio la lección y el portón no, manda el portón y se reporta", async () => {
    const service = commentsWith();
    service.store.post.mockResolvedValueOnce({ kind: "ran", value: { answer: "not_found" } });
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: "Hola" })).toEqual({ kind: "not_found" });
    expect(service.reported).toEqual(["comments_unavailable"]);
  });

  it("el curso abierto sin suscripción lee y no escribe", async () => {
    const service = commentsWith();
    service.store.post.mockResolvedValueOnce(refused({ ok: true, level: "read" }));
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: "Hola" })).toEqual({ kind: "read_only" });
  });

  it("si la base no contestó, se reporta", async () => {
    const service = commentsWith();
    service.store.post.mockRejectedValueOnce(new Error("sin base"));
    expect(await service.postLessonComment(reader, { lessonId: LESSON, parentId: null, body: "Hola" })).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["comments_unavailable"]);
  });
});

describe("editar", () => {
  it("con la revisión que se vio y el texto normalizado; nunca manda una lección", async () => {
    const service = commentsWith();
    expect(await service.editLessonComment(reader, { commentId: COMMENT, body: "Otra vez ", revision: 2 })).toEqual({ kind: "written", id: COMMENT, state: "in_review" });
    expect(service.store.edit).toHaveBeenCalledExactlyOnceWith(claims, { commentId: COMMENT, body: "Otra vez", revision: 2 });
  });

  it("lo que no es un comentario propio sin borrar no existe", async () => {
    const service = commentsWith();
    service.store.edit.mockResolvedValueOnce({ kind: "missing" });
    expect(await service.editLessonComment(reader, { commentId: COMMENT, body: "Otra", revision: 2 })).toEqual({ kind: "not_found" });
    // Borrado en otra pestaña entre leer su lección y editar: lo mismo, y no se reporta, porque puede pasar.
    service.store.edit.mockResolvedValueOnce({ kind: "ran", value: { answer: "not_found" } });
    expect(await service.editLessonComment(reader, { commentId: COMMENT, body: "Otra", revision: 2 })).toEqual({ kind: "not_found" });
    expect(service.reported).toEqual([]);
  });

  it("otra pestaña lo cambió", async () => {
    const service = commentsWith();
    service.store.edit.mockResolvedValueOnce({ kind: "ran", value: { answer: "changed" } });
    expect(await service.editLessonComment(reader, { commentId: COMMENT, body: "Otra", revision: 2 })).toEqual({ kind: "changed" });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("una revisión sin forma (%s) no llega a la guarda", async (revision) => {
    const service = commentsWith();
    expect(await service.editLessonComment(reader, { commentId: COMMENT, body: "Otra", revision })).toEqual({ kind: "not_found" });
    expect(service.checkSession).not.toHaveBeenCalled();
  });

  it("un texto que no pasa, tampoco", async () => {
    const service = commentsWith();
    expect(await service.editLessonComment(reader, { commentId: COMMENT, body: "a".repeat(4001), revision: 1 })).toEqual({ kind: "invalid", reason: "too_long" });
    expect(service.checkSession).not.toHaveBeenCalled();
  });
});

describe("borrar", () => {
  it("con la revisión que se vio, tras la guarda", async () => {
    const service = commentsWith();
    expect(await service.deleteLessonComment(reader, { commentId: COMMENT, revision: 3 })).toEqual({ kind: "deleted" });
    expect(service.store.remove).toHaveBeenCalledExactlyOnceWith(claims, { commentId: COMMENT, revision: 3 });
  });

  it("lo que la base contesta, y lo que no pasa", async () => {
    const service = commentsWith();
    service.store.remove.mockResolvedValueOnce("changed");
    expect(await service.deleteLessonComment(reader, { commentId: COMMENT, revision: 3 })).toEqual({ kind: "changed" });
    service.store.remove.mockResolvedValueOnce("not_found");
    expect(await service.deleteLessonComment(reader, { commentId: COMMENT, revision: 3 })).toEqual({ kind: "not_found" });
    expect(await service.deleteLessonComment(reader, { commentId: "x", revision: 3 })).toEqual({ kind: "not_found" });
    service.store.remove.mockRejectedValueOnce(new Error("sin base"));
    expect(await service.deleteLessonComment(reader, { commentId: COMMENT, revision: 3 })).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["comments_unavailable"]);
  });

  it("sin sesión no se borra", async () => {
    const service = commentsWith({ kind: "anonymous" });
    expect(await service.deleteLessonComment(reader, { commentId: COMMENT, revision: 3 })).toEqual({ kind: "session", check: { kind: "anonymous" } });
    expect(service.store.remove).not.toHaveBeenCalled();
  });
});

describe("el seudónimo", () => {
  it("revisado, tras la guarda", async () => {
    const service = commentsWith();
    expect(await service.chooseCommentName(reader, "  Ana ")).toEqual({ kind: "saved", pseudonym: "Ana" });
    expect(service.store.pseudonym).toHaveBeenCalledExactlyOnceWith(claims, "Ana");
  });

  it("lo que no pasa no llega a la guarda", async () => {
    const service = commentsWith();
    expect(await service.chooseCommentName(reader, "A")).toEqual({ kind: "invalid", reason: "too_short" });
    expect(await service.chooseCommentName(reader, null)).toEqual({ kind: "invalid", reason: "empty" });
    expect(service.checkSession).not.toHaveBeenCalled();
  });

  it.each(["closed", "suspended_account", "banned"] as const)("la base contesta %s", async (answer) => {
    const service = commentsWith();
    service.store.pseudonym.mockResolvedValueOnce({ answer });
    expect(await service.chooseCommentName(reader, "Ana")).toEqual({ kind: answer });
  });

  it("un `invalid` de la base es `invalid`", async () => {
    const service = commentsWith();
    service.store.pseudonym.mockResolvedValueOnce({ answer: "invalid" });
    expect(await service.chooseCommentName(reader, "Ana")).toEqual({ kind: "invalid", reason: "invalid" });
  });
});

describe("«Mis comentarios» (PA-24)", () => {
  it("pide lo propio con las claims de la página, sin la regla, y da por dónde sigue", async () => {
    const comments = commentsWith();
    expect(await comments.myComments(claims, `${AT}_${COMMENT}`)).toEqual({ kind: "ready", items: MINE.items, next: `${AT}_${COMMENT}` });
    expect(comments.store.mine).toHaveBeenCalledExactlyOnceWith(claims, { at: AT, id: COMMENT });
    expect(comments.store.lesson).not.toHaveBeenCalled();
    expect(comments.checkSession).not.toHaveBeenCalled();
  });

  it("un cursor sin forma empieza por lo más reciente; sin más, no hay por dónde seguir", async () => {
    const comments = commentsWith();
    comments.store.mine.mockResolvedValueOnce({ ...MINE, more: false });
    expect(await comments.myComments(claims, "basura")).toEqual({ kind: "ready", items: MINE.items, next: null });
    expect(comments.store.mine).toHaveBeenCalledWith(claims, null);
  });

  it("si la base no supo quién actúa, o falló, «no se supo», y se reporta", async () => {
    const comments = commentsWith();
    comments.store.mine.mockResolvedValueOnce({ answer: "not_found" });
    expect(await comments.myComments(claims, null)).toEqual({ kind: "unavailable" });
    comments.store.mine.mockRejectedValueOnce(new Error("se cayó"));
    expect(await comments.myComments(claims, null)).toEqual({ kind: "unavailable" });
    expect(comments.reported).toEqual(["comments_unavailable", "comments_unavailable"]);
  });
});
