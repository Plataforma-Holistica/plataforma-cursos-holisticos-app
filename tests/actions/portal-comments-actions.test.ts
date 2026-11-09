import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción de PA-45 (T-501), con el servicio simulado: responde, edita y borra por las mismas entradas que la lección, con la
// lección de cada comentario, y una sesión que no pasa vuelve al portal. Lo que hace cada entrada lo prueban la 102 y la 104.

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

import { COMMENT_FIELDS, IDLE_COMMENTS } from "@/app/_comments/state";
import { teacherCommentAction } from "@/app/portal/_comentarios/actions";

const jar = { get: () => undefined, set: () => undefined };
const LESSON = "a0000000-0000-4000-8000-000000000001";
const PARENT = "c0000000-0000-4000-8000-000000000002";

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

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("la acción de PA-45", () => {
  it("responder le pasa al servicio la lección de ese comentario y a qué responde, y vuelve a pintar el portal", async () => {
    const state = await teacherCommentAction({ ...IDLE_COMMENTS, attempt: 2 }, form(["do", `reply:${PARENT}`], [COMMENT_FIELDS.body, "Gracias"]));
    expect(mocks.postLessonComment).toHaveBeenCalledExactlyOnceWith(jar, { lessonId: LESSON, parentId: PARENT, body: "Gracias" });
    expect(calls.order).toEqual(["postLessonComment", "refresh"]);
    expect(state).toMatchObject({ attempt: 3, written: "c0000000-0000-4000-8000-000000000009" });
  });

  it("lo que contesta el portón se dice en su campo, y lo escrito se queda", async () => {
    for (const answer of ["closed", "banned", "suspended", "needs_notice"] as const) {
      once("postLessonComment", { kind: "gate", answer });
      const state = await teacherCommentAction(IDLE_COMMENTS, form(["do", `reply:${PARENT}`], [COMMENT_FIELDS.body, "Hola"]));
      expect(state).toMatchObject({ notice: { at: { kind: "reply", parentId: PARENT }, kind: answer }, kept: { body: "Hola" } });
    }
    once("postLessonComment", { kind: "bad_parent" });
    expect(await teacherCommentAction(IDLE_COMMENTS, form(["do", `reply:${PARENT}`], [COMMENT_FIELDS.body, "Hola"]))).toMatchObject({ notice: { kind: "bad_parent" } });
  });

  it("la sesión que no pasa sale a entrar y vuelve a PA-45", async () => {
    once("postLessonComment", { kind: "session", check: { kind: "anonymous" } });
    await expect(teacherCommentAction(IDLE_COMMENTS, form(["do", `reply:${PARENT}`], [COMMENT_FIELDS.body, "Hola"]))).rejects.toThrow("redirige");
    expect(calls.order.at(-1)).toMatch(/^redirect \/entrar\?/);
    expect(calls.order.at(-1)).toContain(encodeURIComponent("/portal/comentarios"));
  });

  it("sin lección con forma o sin botón, no llama a nadie", async () => {
    const bare = new FormData();
    bare.append("do", `reply:${PARENT}`);
    expect(await teacherCommentAction(IDLE_COMMENTS, bare)).toEqual({ ...IDLE_COMMENTS, attempt: 1 });
    expect(await teacherCommentAction(IDLE_COMMENTS, form(["do", "x"]))).toEqual({ ...IDLE_COMMENTS, attempt: 1 });
    expect(calls.order).toEqual([]);
  });
});
