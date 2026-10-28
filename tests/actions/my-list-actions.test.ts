import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de Mi lista (RF-311; T-210), con los servicios simulados: qué le pasa cada una
// a su servicio, en qué orden, y qué hace con cada respuesta. Lo que el servicio hace de verdad
// lo prueba tests/integration/71-mi-lista.test.ts.

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
    saveCourse: logged("saveCourse", () => Promise.resolve<unknown>({ kind: "saved" })),
    removeCourse: logged("removeCourse", () => Promise.resolve<unknown>({ kind: "removed" })),
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
vi.mock("@/services/browse/browse", () => ({ saveCourse: mocks.saveCourse, removeCourse: mocks.removeCourse }));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: mocks.forgetBrowserProofs }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { courseListAction, exploreListAction, homeListAction } from "@/app/_catalog/my-list/actions";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;

function form(...values: [string, string][]): FormData {
  const data = new FormData();
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

const ACTIONS = [
  ["courseListAction", courseListAction, "/cursos/respirar"],
  ["homeListAction", homeListAction, "/inicio"],
  ["exploreListAction", exploreListAction, "/explorar"],
] as const;

describe.each(ACTIONS)("%s", (_, action, back) => {
  it("guardar: le pasa al servicio el tarro y el curso, y nada más del formulario; pide la página de nuevo", async () => {
    const answer = await action(IDLE, form(["do", "save:respirar"], ["profile", "otra-cuenta"], ["volver", "//otro.example"]));
    expect(mocks.saveCourse).toHaveBeenCalledExactlyOnceWith(jar, "respirar");
    expect(answer).toEqual({ kind: "saved", slug: "respirar", attempt: 1 });
    expect(calls.order).toEqual(["saveCourse", "refresh"]);
  });

  it("quitar: la intención es quitar, no cambiar", async () => {
    expect(await action({ kind: "saved", slug: "respirar", attempt: 4 }, form(["do", "remove:respirar"]))).toEqual({
      kind: "removed",
      slug: "respirar",
      attempt: 5,
    });
    expect(mocks.removeCourse).toHaveBeenCalledExactlyOnceWith(jar, "respirar");
    expect(mocks.saveCourse).not.toHaveBeenCalled();
  });

  it("un envío sin botón, o con dos, no le pregunta nada a nadie", async () => {
    expect(await action(IDLE, form())).toEqual(IDLE);
    expect(await action(IDLE, form(["do", "save:uno"], ["do", "save:dos"]))).toEqual(IDLE);
    expect(await action(IDLE, form(["do", "save:../uno"]))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it.each([
    [{ kind: "not_found" }, "gone"],
    [{ kind: "unavailable" }, "unavailable"],
    [{ kind: "session", check: { kind: "unavailable" } }, "unavailable"],
  ])("%j se dice en la pantalla, que se pide de nuevo", async (result, kind) => {
    once("saveCourse", result);
    expect(await action(IDLE, form(["do", "save:respirar"]))).toEqual({ kind, slug: "respirar", attempt: 1 });
    expect(calls.order).toEqual(["saveCourse", "refresh"]);
  });

  it("sin sesión, a entrar y de vuelta a su pantalla", async () => {
    once("saveCourse", { kind: "session", check: { kind: "anonymous" } });
    await expect(action(IDLE, form(["do", "save:respirar"]))).rejects.toThrow();
    expect(calls.order).toEqual(["saveCourse", `redirect /entrar?volver=${encodeURIComponent(back)}`]);
  });

  it("suspendida, a su pantalla, donde decide la guarda", async () => {
    once("removeCourse", { kind: "session", check: { kind: "suspended" } });
    await expect(action(IDLE, form(["do", "remove:respirar"]))).rejects.toThrow();
    expect(calls.order).toEqual(["removeCourse", `redirect ${back}`]);
  });

  it("una sesión que ya no vale se cierra antes de irse", async () => {
    once("saveCourse", { kind: "session", check: { kind: "must_sign_out", then: "recover" } });
    await expect(action(IDLE, form(["do", "save:respirar"]))).rejects.toThrow();
    expect(calls.order).toEqual(["saveCourse", "signOut", "leaveNotice", "redirect /recuperar"]);
  });
});
