import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción de los comentarios de PA-22 (T-501), con el servicio simulado: qué le pasa al servicio, en qué orden, y qué
// devuelve. Lo que el servicio hace de verdad lo prueba tests/integration/102-comentarios-servicio.test.ts; lo que pinta
// cada respuesta, `comment-outcomes.test.ts`.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  return {
    postLessonComment: logged("postLessonComment", () => Promise.resolve<unknown>({ kind: "written", id: "c0000000-0000-4000-8000-000000000009", state: "published" })),
    editLessonComment: logged("editLessonComment", () => Promise.resolve<unknown>({ kind: "written", id: "c0000000-0000-4000-8000-000000000001", state: "published" })),
    deleteLessonComment: logged("deleteLessonComment", () => Promise.resolve<unknown>({ kind: "deleted" })),
    chooseCommentName: logged("chooseCommentName", () => Promise.resolve<unknown>({ kind: "saved", pseudonym: "Luz" })),
    signOut: logged("signOut", () => Promise.resolve("closed")),
    forgetBrowserProofs: logged("forgetBrowserProofs", () => undefined),
    leaveNotice: logged("leaveNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push(`redirect ${to}`);
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/comments/comments", () => ({
  postLessonComment: mocks.postLessonComment,
  editLessonComment: mocks.editLessonComment,
  deleteLessonComment: mocks.deleteLessonComment,
  chooseCommentName: mocks.chooseCommentName,
}));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: mocks.forgetBrowserProofs }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { lessonCommentAction } from "@/app/cursos/[slug]/lecciones/[leccion]/comment-actions";
import { COMMENT_FIELDS, IDLE_COMMENTS } from "@/app/cursos/[slug]/lecciones/[leccion]/comment-outcomes";

const jar = { get: () => undefined, set: () => undefined };
const LESSON = "a0000000-0000-4000-8000-000000000001";
const ID = "c0000000-0000-4000-8000-000000000001";
const PARENT = "c0000000-0000-4000-8000-000000000002";
const BACK = `/cursos/respirar/lecciones/${LESSON}`;

function form(...values: [string, string][]): FormData {
  const data = new FormData();
  data.append(COMMENT_FIELDS.course, "respirar");
  data.append(COMMENT_FIELDS.lesson, LESSON);
  for (const [field, value] of values) data.append(field, value);
  return data;
}

function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

const previous = { ...IDLE_COMMENTS, attempt: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("la acción de los comentarios de la lección", () => {
  it("abrir y cerrar no llaman al servicio ni vuelven a pintar la página", async () => {
    const state = await lessonCommentAction(previous, form(["do", `open-reply:${PARENT}`]));
    expect(state).toEqual({ ...IDLE_COMMENTS, open: { kind: "reply", parentId: PARENT }, attempt: 5 });
    await lessonCommentAction(previous, form(["do", `ask-delete:${ID}`]));
    await lessonCommentAction(previous, form(["do", "cancel"]));
    expect(calls.order).toEqual([]);
  });

  it("publicar le pasa al servicio la lección, a qué responde y el texto, y vuelve a pintar la página", async () => {
    const state = await lessonCommentAction(previous, form(["do", `reply:${PARENT}`], [COMMENT_FIELDS.body, "Gracias"]));
    expect(mocks.postLessonComment).toHaveBeenCalledExactlyOnceWith(jar, { lessonId: LESSON, parentId: PARENT, body: "Gracias" });
    expect(calls.order).toEqual(["postLessonComment", "refresh"]);
    expect(state).toMatchObject({ attempt: 5, written: "c0000000-0000-4000-8000-000000000009", open: { kind: "none" } });
  });

  it("editar y borrar llevan el comentario y la revisión que se vio", async () => {
    await lessonCommentAction(previous, form(["do", `save:${ID}:3`], [COMMENT_FIELDS.body, "Otro"]));
    expect(mocks.editLessonComment).toHaveBeenCalledExactlyOnceWith(jar, { commentId: ID, revision: 3, body: "Otro" });
    await lessonCommentAction(previous, form(["do", `delete:${ID}:7`]));
    expect(mocks.deleteLessonComment).toHaveBeenCalledExactlyOnceWith(jar, { commentId: ID, revision: 7 });
    expect(calls.order).toEqual(["editLessonComment", "refresh", "deleteLessonComment", "refresh"]);
  });

  it("sin seudónimo, no vuelve a pintar la página: abre el diálogo con lo escrito", async () => {
    once("postLessonComment", { kind: "gate", answer: "needs_pseudonym" });
    const state = await lessonCommentAction(previous, form(["do", "post"], [COMMENT_FIELDS.body, "Hola"]));
    expect(calls.order).toEqual(["postLessonComment"]);
    expect(state.open).toEqual({ kind: "name", carry: { parentId: null, body: "Hola" } });
  });

  it("«Cambiar» no llama a nadie y conserva lo escrito en el campo", async () => {
    const state = await lessonCommentAction(previous, form(["do", "ask-name"], [COMMENT_FIELDS.body, "Hola"]));
    expect(calls.order).toEqual([]);
    expect(state).toMatchObject({ open: { kind: "name", carry: null }, kept: { at: { kind: "new" }, body: "Hola" } });
  });

  it("elegir el nombre con algo que cruzaba lo publica después, en ese orden", async () => {
    const state = await lessonCommentAction(previous, form(["do", "name"], [COMMENT_FIELDS.name, "Luz"], [COMMENT_FIELDS.carry, "Hola"], [COMMENT_FIELDS.carryParent, PARENT]));
    expect(mocks.chooseCommentName).toHaveBeenCalledExactlyOnceWith(jar, "Luz");
    expect(mocks.postLessonComment).toHaveBeenCalledExactlyOnceWith(jar, { lessonId: LESSON, parentId: PARENT, body: "Hola" });
    expect(calls.order).toEqual(["chooseCommentName", "postLessonComment", "refresh"]);
    expect(state.written).toBe("c0000000-0000-4000-8000-000000000009");
  });

  it("un nombre que no sirve no publica nada", async () => {
    once("chooseCommentName", { kind: "invalid", reason: "too_short" });
    const state = await lessonCommentAction(previous, form(["do", "name"], [COMMENT_FIELDS.name, "L"], [COMMENT_FIELDS.carry, "Hola"]));
    expect(calls.order).toEqual(["chooseCommentName"]);
    expect(state.open).toEqual({ kind: "name", carry: { parentId: null, body: "Hola" } });
  });

  it("la sesión que no pasa sale de la pantalla", async () => {
    once("postLessonComment", { kind: "session", check: { kind: "anonymous" } });
    await expect(lessonCommentAction(previous, form(["do", "post"], [COMMENT_FIELDS.body, "Hola"]))).rejects.toThrow("redirige");
    expect(calls.order.at(-1)).toMatch(/^redirect \/entrar\?/);
    expect(calls.order.at(-1)).toContain(encodeURIComponent(BACK));
  });

  it("sin lección o sin botón con forma, no llama a nadie", async () => {
    const bare = new FormData();
    bare.append("do", "post");
    bare.append(COMMENT_FIELDS.body, "Hola");
    expect(await lessonCommentAction(previous, bare)).toEqual({ ...IDLE_COMMENTS, attempt: 5 });
    expect(await lessonCommentAction(previous, form(["do", "postear"]))).toEqual({ ...IDLE_COMMENTS, attempt: 5 });
    expect(await lessonCommentAction("cualquier cosa" as never, form(["do", "postear"]))).toEqual({ ...IDLE_COMMENTS, attempt: 1 });
    expect(calls.order).toEqual([]);
  });
});
