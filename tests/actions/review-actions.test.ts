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
    returnCourse: logged("returnCourse", unavailable),
    getMediaGrant: logged("getMediaGrant", unavailable),
    getReviewVideoGrant: logged("getReviewVideoGrant", unavailable),
    getReviewResourceGrant: logged("getReviewResourceGrant", unavailable),
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
vi.mock("@/services/review/review", () => ({ approveCourse: mocks.approveCourse, returnCourse: mocks.returnCourse }));
vi.mock("@/services/media/media", () => ({ getMediaGrant: mocks.getMediaGrant, getReviewVideoGrant: mocks.getReviewVideoGrant, getReviewResourceGrant: mocks.getReviewResourceGrant }));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { approveAction, lessonVideoAction, returnAction, reviewCodeAction, reviewResourceAction, reviewVideoAction } from "@/app/admin/_revision/actions";
import { returnButton, reviewButton } from "@/app/admin/_revision/outcomes";

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
    once("getMediaGrant", { kind: "granted", playbackId: "PlaybackDePrueba", tokens: { video: "v", thumbnail: "t", storyboard: "s" }, expiresAt: 9, speeds: [1, 1.25] });
    expect(await lessonVideoAction(LESSON)).toEqual({
      kind: "granted",
      playbackId: "PlaybackDePrueba",
      tokens: { playback: "v", thumbnail: "t", storyboard: "s" },
      speeds: [1, 1.25],
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

describe("returnAction", () => {
  const SUBMISSION = "f0000000-0000-4000-8000-000000000001";
  const NONE = { reason: null, whatToFix: null };
  const sending = (reason: string, whatToFix: string) => {
    const data = pressed(returnButton.send(COURSE, SUBMISSION));
    data.append("motivo", reason);
    data.append("que_corregir", whatToFix);
    return data;
  };
  const open = { kind: "open", course: COURSE, submission: SUBMISSION, reason: "", whatToFix: "", problems: NONE, failure: null, attempt: 1 } as const;

  it("«Devolver» abre los campos: no llama a nadie", async () => {
    expect(await returnAction(IDLE, pressed(returnButton.ask(COURSE, SUBMISSION)))).toEqual(open);
    expect(calls.order).toEqual([]);
  });

  it("«Cancelar», o un envío vacío, no llama a nadie", async () => {
    expect(await returnAction(open, pressed(returnButton.cancel()))).toEqual(IDLE);
    expect(await returnAction(open, new FormData())).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it("sin motivo no se llama al servicio, y lo escrito vuelve", async () => {
    expect(await returnAction(open, sending("  ", "Corrige."))).toEqual({ ...open, reason: "  ", whatToFix: "Corrige.", problems: { reason: "empty", whatToFix: null }, attempt: 2 });
    expect(calls.order).toEqual([]);
  });

  it("devuelto: redirige con el aviso", async () => {
    once("returnCourse", { kind: "answered", answer: "returned" });
    await expect(returnAction(open, sending("Motivo.", "Corrige."))).rejects.toThrow("redirige a /admin/revision");
    expect(mocks.returnCourse).toHaveBeenCalledWith(jar, { course: COURSE, submission: SUBMISSION, reason: "Motivo.", whatToFix: "Corrige." });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "course_returned");
    expect(calls.order).toEqual(["returnCourse", "leaveNotice", "redirect"]);
  });

  it("lo que no se hizo se dice, con lo escrito, y la página se vuelve a pedir", async () => {
    once("returnCourse", { kind: "answered", answer: "changed" });
    expect(await returnAction(open, sending("Motivo.", "Corrige."))).toEqual({ ...open, reason: "Motivo.", whatToFix: "Corrige.", failure: "changed", attempt: 2 });
    expect(calls.order).toEqual(["returnCourse", "refresh"]);
  });

  it("del estado anterior solo se lee el intento: qué curso sale del botón", async () => {
    once("returnCourse", { kind: "answered", answer: "not_pending" });
    await returnAction({ ...open, course: "c0000000-0000-4000-8000-00000000000f" }, sending("Motivo.", "Corrige."));
    expect(mocks.returnCourse).toHaveBeenCalledWith(jar, expect.objectContaining({ course: COURSE }));
  });
});

describe("reviewVideoAction", () => {
  it("le pasa el curso y la lección a la función única de medios", async () => {
    once("getReviewVideoGrant", { kind: "granted", playbackId: "P", tokens: { video: "v", thumbnail: "t", storyboard: "s" }, expiresAt: 1, speeds: [1], watermark: "yo@prueba.test" });
    expect(await reviewVideoAction(COURSE, LESSON)).toMatchObject({ kind: "granted", watermark: "yo@prueba.test" });
    expect(mocks.getReviewVideoGrant).toHaveBeenCalledWith(jar, COURSE, LESSON);
  });

  it("a quien la guarda no dejó se le manda a esta misma página", async () => {
    once("getReviewVideoGrant", { kind: "refused" });
    await expect(reviewVideoAction(COURSE, LESSON)).rejects.toThrow("redirige a /admin/revision");
  });
});

describe("reviewResourceAction", () => {
  const RESOURCE = "a1000000-0000-4000-8000-000000000001";
  const download = (js: boolean) => {
    const data = pressed(`download:${RESOURCE}`);
    if (js) data.append("canal", "js");
    return data;
  };

  it("un envío vacío no llama a nadie", async () => {
    expect(await reviewResourceAction(IDLE, new FormData())).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it("sin JavaScript redirige al archivo", async () => {
    once("getReviewResourceGrant", { kind: "granted", url: "https://storage/bajar" });
    await expect(reviewResourceAction(IDLE, download(false))).rejects.toThrow("redirige a https://storage/bajar");
    expect(mocks.getReviewResourceGrant).toHaveBeenCalledWith(jar, RESOURCE);
  });

  it("lo que ya no existe se dice", async () => {
    once("getReviewResourceGrant", { kind: "not_found" });
    expect(await reviewResourceAction(IDLE, download(false))).toEqual({ kind: "gone", attempt: 1 });
  });
});
