import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción de «Mis comentarios» (PA-24; T-501), con el servicio simulado: qué le pasa al servicio y qué devuelve. Lo que hace
// el servicio de verdad lo prueba tests/integration/103-mis-comentarios.test.ts.

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
    deleteLessonComment: logged("deleteLessonComment", () => Promise.resolve<unknown>({ kind: "deleted" })),
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
vi.mock("@/services/comments/comments", () => ({ deleteLessonComment: mocks.deleteLessonComment }));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: mocks.forgetBrowserProofs }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { myCommentsAction } from "@/app/(cuenta)/cuenta/comentarios/actions";
import { IDLE_MINE } from "@/app/(cuenta)/cuenta/comentarios/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const ID = "c0000000-0000-4000-8000-000000000001";

function form(...values: [string, string][]): FormData {
  const data = new FormData();
  for (const [field, value] of values) data.append(field, value);
  return data;
}

function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

const previous = { ...IDLE_MINE, attempt: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("la acción de «Mis comentarios»", () => {
  it("preguntar y cancelar no llaman a nadie", async () => {
    expect(await myCommentsAction(previous, form(["do", `ask-delete:${ID}`]))).toEqual({ attempt: 3, asking: ID, notice: null });
    expect(await myCommentsAction(previous, form(["do", "cancel"]))).toEqual({ attempt: 3, asking: null, notice: null });
    expect(calls.order).toEqual([]);
  });

  it("borrar le pasa al servicio el comentario y la revisión que se vio, y vuelve a leer la lista", async () => {
    const state = await myCommentsAction(previous, form(["do", `delete:${ID}:4`]));
    expect(mocks.deleteLessonComment).toHaveBeenCalledExactlyOnceWith(jar, { commentId: ID, revision: 4 });
    expect(calls.order).toEqual(["deleteLessonComment", "refresh"]);
    expect(state).toEqual({ attempt: 3, asking: null, notice: { kind: "deleted", id: null } });
  });

  it("la sesión que no pasa sale a entrar y vuelve a la página en que estaba", async () => {
    once("deleteLessonComment", { kind: "session", check: { kind: "anonymous" } });
    await expect(myCommentsAction(previous, form(["do", `delete:${ID}:4`], ["desde", `2026-11-03T18:00:00+00:00_${ID}`]))).rejects.toThrow("redirige");
    expect(calls.order.at(-1)).toMatch(/^redirect \/entrar\?/);
    expect(calls.order.at(-1)).toContain(encodeURIComponent(`/cuenta/comentarios?desde=${encodeURIComponent(`2026-11-03T18:00:00+00:00_${ID}`)}`));
  });

  it("sin botón con forma, no llama a nadie", async () => {
    expect(await myCommentsAction(previous, form(["do", "borrar"]))).toEqual({ ...IDLE_MINE, attempt: 3 });
    expect(await myCommentsAction("cualquier cosa" as never, form())).toEqual({ ...IDLE_MINE, attempt: 1 });
    expect(calls.order).toEqual([]);
  });
});
