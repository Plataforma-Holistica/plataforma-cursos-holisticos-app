import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de crear y borrar un curso (T-402; PA-42), con los servicios simulados: qué le pasa
// cada una a su servicio, en qué orden, y qué hace con cada respuesta. Lo que el servicio hace de
// verdad lo prueban tests/integration/72-borrador.test.ts y la 73.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  const unknown = () => Promise.resolve<unknown>({ kind: "unknown" });
  return {
    createCourse: logged("createCourse", unknown),
    deleteCourse: logged("deleteCourse", unknown),
    leaveNotice: logged("leaveNotice", () => undefined),
    signOut: logged("signOut", () => Promise.resolve()),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/drafts/editor", () => ({ createCourse: mocks.createCourse, deleteCourse: mocks.deleteCourse }));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { createCourseAction, deleteCourseAction } from "@/app/portal/_cursos/actions";
import { deleteButton } from "@/app/portal/_cursos/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const COURSE = "c0000000-0000-4000-8000-000000000001";
const TOKEN = "b0000000-0000-4000-8000-000000000001";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
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

describe("crear un curso", () => {
  it("le pasa al servicio el testigo y el título tal como llegaron, y creado se va al editor", async () => {
    once("createCourse", { kind: "created", id: COURSE });
    await expect(createCourseAction(IDLE, form([["title", "Respirar"], ["token", TOKEN]]))).rejects.toThrow(`redirige a /portal/cursos/${COURSE}`);
    expect(mocks.createCourse).toHaveBeenCalledExactlyOnceWith(jar, { token: TOKEN, title: "Respirar" });
    expect(calls.order).toEqual(["createCourse", "redirect"]);
  });

  it("un título sin forma no llega al servicio, y vuelve con lo escrito y el mismo testigo", async () => {
    expect(await createCourseAction(IDLE, form([["title", "  "], ["token", TOKEN]]))).toEqual({
      kind: "invalid",
      problem: "required",
      title: "  ",
      token: TOKEN,
      attempt: 1,
    });
    expect(mocks.createCourse).not.toHaveBeenCalled();
  });

  it("«no se supo» devuelve el mismo testigo: reintentar no crea otro curso", async () => {
    const first = await createCourseAction(IDLE, form([["title", "Respirar"], ["token", TOKEN]]));
    expect(first).toEqual({ kind: "failed", reason: "unavailable", title: "Respirar", token: TOKEN, attempt: 1 });
    once("createCourse", { kind: "created", id: COURSE });
    await expect(createCourseAction(first, form([["title", "Respirar"], ["token", TOKEN]]))).rejects.toThrow("redirige");
    expect(mocks.createCourse).toHaveBeenLastCalledWith(jar, { token: TOKEN, title: "Respirar" });
  });

  it("sin un testigo con forma no se crea nada, y el formulario recibe uno nuevo", async () => {
    const state = await createCourseAction(IDLE, form([["title", "Respirar"], ["token", "inventado"]]));
    expect(state).toMatchObject({ kind: "failed", reason: "unavailable", title: "Respirar" });
    expect(state.kind === "failed" && /^[0-9a-f-]{36}$/.test(state.token)).toBe(true);
    expect(mocks.createCourse).not.toHaveBeenCalled();
  });

  it("al maestro suspendido lo regresa a la pantalla, donde decide la guarda", async () => {
    once("createCourse", { kind: "suspended" });
    await expect(createCourseAction(IDLE, form([["title", "Respirar"], ["token", TOKEN]]))).rejects.toThrow("redirige a /portal/cursos/nuevo");
  });

  it("una sesión que ya no vale se cierra antes de irse", async () => {
    once("createCourse", { kind: "session", check: { kind: "must_sign_out", then: "sign_in" } });
    await expect(createCourseAction(IDLE, form([["title", "Respirar"], ["token", TOKEN]]))).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["createCourse", "signOut", "redirect"]);
  });
});

describe("borrar un curso", () => {
  it("le pasa al servicio el curso y la revisión del botón, y borrado vuelve a la lista con su aviso", async () => {
    once("deleteCourse", { kind: "deleted" });
    await expect(deleteCourseAction(IDLE, form([["do", deleteButton(COURSE, 4)]]))).rejects.toThrow("redirige a /portal/cursos");
    expect(mocks.deleteCourse).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, seen: 4 });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "course_deleted");
    expect(calls.order).toEqual(["deleteCourse", "leaveNotice", "redirect"]);
  });

  it("reenviado, el curso ya no existe: a la lista, con el aviso que lo dice", async () => {
    once("deleteCourse", { kind: "not_found" });
    await expect(deleteCourseAction(IDLE, form([["do", deleteButton(COURSE, 4)]]))).rejects.toThrow("redirige a /portal/cursos");
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "course_gone");
  });

  it("si cambió en otra pestaña, no se borra: lo dice y vuelve a leer", async () => {
    once("deleteCourse", { kind: "changed" });
    expect(await deleteCourseAction(IDLE, form([["do", deleteButton(COURSE, 4)]]))).toEqual({ kind: "failed", reason: "changed", attempt: 1 });
    expect(calls.order).toEqual(["deleteCourse", "refresh"]);
  });

  it("un formulario sin botón con forma no llama a nadie", async () => {
    expect(await deleteCourseAction(IDLE, form([["do", "delete:x:4"]]))).toEqual(IDLE);
    expect(mocks.deleteCourse).not.toHaveBeenCalled();
  });
});
