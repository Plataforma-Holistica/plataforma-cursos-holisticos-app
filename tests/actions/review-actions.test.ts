import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de la pantalla de revisión (PA-61 y PA-62 mínimas; T-108), con los
// servicios simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada
// respuesta. Lo que los servicios hacen de verdad lo prueban sus pruebas de integración.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  const unavailable = () => Promise.resolve<unknown>({ kind: "unavailable" });
  return {
    giveCatalogCode: logged("giveCatalogCode", unavailable),
    approveCourse: logged("approveCourse", unavailable),
    getMediaGrant: logged("getMediaGrant", unavailable),
    leaveNotice: logged("leaveNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/catalog/catalog", () => ({ giveCatalogCode: mocks.giveCatalogCode }));
vi.mock("@/services/review/review", () => ({ approveCourse: mocks.approveCourse }));
vi.mock("@/services/media/media", () => ({ getMediaGrant: mocks.getMediaGrant }));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { approveAction, lessonVideoAction, reviewCodeAction } from "@/app/admin/_revision/actions";
import { reviewButton } from "@/app/admin/_revision/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const COURSE = "c0000000-0000-4000-8000-000000000002";
const LESSON = "d0000000-0000-4000-8000-000000000003";

const pressed = (value: string) => {
  const data = new FormData();
  data.append("do", value);
  return data;
};

/** Lo que contesta la siguiente llamada a esa simulación. */
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("approveAction", () => {
  it("«Aprobar y publicar» solo pregunta: no llama a nadie", async () => {
    expect(await approveAction(IDLE, pressed(reviewButton.ask(COURSE)))).toEqual({ kind: "confirming", course: COURSE, attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("«Cancelar», o un envío vacío, no llama a nadie", async () => {
    expect(await approveAction(IDLE, pressed(reviewButton.cancel()))).toEqual(IDLE);
    expect(await approveAction(IDLE, new FormData())).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it("confirmar: le pasa al servicio el curso del botón y, aprobado, redirige con el aviso", async () => {
    once("approveCourse", { kind: "answered", answer: "approved" });
    await expect(approveAction({ kind: "confirming", course: COURSE, attempt: 1 }, pressed(reviewButton.confirm(COURSE)))).rejects.toThrow(
      "redirige a /admin/revision",
    );
    expect(mocks.approveCourse).toHaveBeenCalledWith(jar, { course: COURSE });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "course_approved");
    expect(calls.order).toEqual(["approveCourse", "leaveNotice", "redirect"]);
  });

  it("lo que no se hizo se dice, y la página se vuelve a pedir: la cola pudo cambiar", async () => {
    once("approveCourse", { kind: "answered", answer: "not_pending" });
    expect(await approveAction(IDLE, pressed(reviewButton.confirm(COURSE)))).toEqual({ kind: "failed", reason: "not_pending", attempt: 1 });
    expect(calls.order).toEqual(["approveCourse", "refresh"]);
  });

  it("a quien la guarda no dejó, a la página: decide su guarda", async () => {
    once("approveCourse", { kind: "refused" });
    await expect(approveAction(IDLE, pressed(reviewButton.confirm(COURSE)))).rejects.toThrow("redirige a /admin/revision");
    expect(calls.order).toEqual(["approveCourse", "redirect"]);
  });
});

describe("reviewCodeAction", () => {
  it("un código sin forma no llega al servicio", async () => {
    const data = new FormData();
    data.append("code", "12");
    expect(await reviewCodeAction(IDLE, data)).toEqual({ kind: "invalid", problem: "invalid", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("con forma, al servicio del catálogo (la misma puerta); verificado, a esta página", async () => {
    once("giveCatalogCode", { kind: "verified" });
    const data = new FormData();
    data.append("code", "123 456");
    await expect(reviewCodeAction(IDLE, data)).rejects.toThrow("redirige a /admin/revision");
    expect(mocks.giveCatalogCode).toHaveBeenCalledWith(jar, "123 456");
  });
});

describe("lessonVideoAction", () => {
  it("le pasa la lección a la función única de medios y devuelve los tokens con los nombres de Mux Player", async () => {
    once("getMediaGrant", { kind: "granted", playbackId: "PlaybackDePrueba", tokens: { video: "v", thumbnail: "t", storyboard: "s" }, expiresAt: 9 });
    expect(await lessonVideoAction(LESSON)).toEqual({
      kind: "granted",
      playbackId: "PlaybackDePrueba",
      tokens: { playback: "v", thumbnail: "t", storyboard: "s" },
    });
    expect(mocks.getMediaGrant).toHaveBeenCalledWith(jar, LESSON, "review");
  });

  it("lo que llegue, sea lo que sea, va tal cual a la función: ella lo revisa", async () => {
    once("getMediaGrant", { kind: "no_video" });
    expect(await lessonVideoAction({ playbackId: "inventado" })).toEqual({ kind: "no_video" });
    expect(mocks.getMediaGrant).toHaveBeenCalledWith(jar, { playbackId: "inventado" }, "review");
  });

  it("a quien no puede, a la página: decide su guarda", async () => {
    once("getMediaGrant", { kind: "refused" });
    await expect(lessonVideoAction(LESSON)).rejects.toThrow("redirige a /admin/revision");
  });

  it("no se supo: unavailable, sin volver a pedir la página", async () => {
    expect(await lessonVideoAction(LESSON)).toEqual({ kind: "unavailable" });
    expect(calls.order).toEqual(["getMediaGrant"]);
  });
});
