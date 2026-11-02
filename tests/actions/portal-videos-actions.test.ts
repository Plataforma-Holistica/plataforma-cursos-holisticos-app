import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones del video de una lección (T-403; PA-43), con los servicios simulados: qué le pasa a cada servicio y qué hace con cada
// respuesta. Lo que el servicio hace de verdad lo prueban tests/integration/92-videos-subir.test.ts y el extremo a extremo.

const mocks = vi.hoisted(() => ({
  beginVideo: vi.fn(),
  renewVideoUpload: vi.fn(),
  confirmVideo: vi.fn(),
  removeVideo: vi.fn(),
  refresh: vi.fn(),
  leaveFor: vi.fn((_jar: unknown, outcome: { to: string }) => {
    throw new Error(`sale a ${outcome.to}`);
  }),
  cookieJar: vi.fn(() => Promise.resolve({ jar: true })),
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/app/(cuenta)/_lib/exit", () => ({ leaveFor: mocks.leaveFor }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
vi.mock("@/services/drafts/editor", () => ({
  beginVideo: mocks.beginVideo,
  renewVideoUpload: mocks.renewVideoUpload,
  confirmVideo: mocks.confirmVideo,
  removeVideo: mocks.removeVideo,
}));

const { beginVideoAction, confirmVideoAction, removeVideoAction, renewVideoAction } = await import("@/app/portal/_editor/video-actions");

const COURSE = "c0000000-0000-4000-8000-000000000001";
const LESSON = "e0000000-0000-4000-8000-000000000001";
const VIDEO = "f0000000-0000-4000-8000-000000000001";
const JAR = { jar: true };
const BEGIN = { course: COURSE, lesson: LESSON, fileName: "clase.mp4", size: 10 };
const ONE = { course: COURSE, lesson: LESSON, video: VIDEO };
const BACK = `/portal/cursos/${COURSE}?leccion=${LESSON}`;

beforeEach(() => vi.clearAllMocks());

describe("beginVideoAction", () => {
  it("le pasa al servicio lo que llegó y contesta a dónde subir", async () => {
    mocks.beginVideo.mockResolvedValue({ kind: "go", video: VIDEO, path: "p", mime: "video/mp4", bucket: "b", endpoint: "e", token: "t", resumed: true });
    expect(await beginVideoAction(BEGIN)).toEqual({ kind: "go", target: { video: VIDEO, path: "p", mime: "video/mp4", bucket: "b", endpoint: "e" }, token: "t", resumed: true });
    expect(mocks.beginVideo).toHaveBeenCalledWith(JAR, BEGIN);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("lo que no tiene forma cuenta como vacío", async () => {
    mocks.beginVideo.mockResolvedValue({ kind: "invalid" });
    expect(await beginVideoAction("nada" as never)).toEqual({ kind: "problem", problem: "fileType" });
    expect(mocks.beginVideo).toHaveBeenCalledWith(JAR, { course: "", lesson: "", fileName: "", size: 0 });
    await beginVideoAction({ course: 1, lesson: {}, fileName: [], size: "9" } as never);
    expect(mocks.beginVideo).toHaveBeenLastCalledWith(JAR, { course: "", lesson: "", fileName: "", size: 0 });
  });

  it("otra subida a medias dice cuál", async () => {
    mocks.beginVideo.mockResolvedValue({ kind: "pending", video: VIDEO, fileName: "otra.mp4" });
    expect(await beginVideoAction(BEGIN)).toEqual({ kind: "pending", fileName: "otra.mp4" });
  });

  it.each([
    ["busy", "busy", true],
    ["closed", "closed", false],
    ["throttled", "throttled", false],
    ["too_large", "fileSize", false],
    ["invalid", "fileType", false],
    ["unavailable", "unavailable", false],
    ["unknown", "unavailable", false],
    ["not_found", "gone", true],
  ])("%s se dice como %s", async (kind, problem, refreshes) => {
    mocks.beginVideo.mockResolvedValue({ kind });
    expect(await beginVideoAction(BEGIN)).toEqual({ kind: "problem", problem });
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshes ? 1 : 0);
  });

  it.each(["suspended", "not_teacher", "not_editable"])("%s vuelve a la misma ruta, donde la guarda decide", async (kind) => {
    mocks.beginVideo.mockResolvedValue({ kind });
    await expect(beginVideoAction(BEGIN)).rejects.toThrow(`sale a ${BACK}`);
  });

  it("una sesión que ya no pasa sale", async () => {
    mocks.beginVideo.mockResolvedValue({ kind: "session", check: { kind: "anonymous" } });
    await expect(beginVideoAction(BEGIN)).rejects.toThrow(/sale a/);
  });
});

describe("renewVideoAction", () => {
  it("da la firma nueva", async () => {
    mocks.renewVideoUpload.mockResolvedValue({ kind: "renewed", token: "t2" });
    expect(await renewVideoAction(ONE)).toEqual({ kind: "renewed", token: "t2" });
    expect(mocks.renewVideoUpload).toHaveBeenCalledWith(JAR, { course: COURSE, video: VIDEO });
  });

  it("un video que ya no sube lo dice, y lo demás es no se supo", async () => {
    mocks.renewVideoUpload.mockResolvedValue({ kind: "not_found" });
    expect(await renewVideoAction(ONE)).toEqual({ kind: "problem", problem: "gone" });
    mocks.renewVideoUpload.mockResolvedValue({ kind: "unknown" });
    expect(await renewVideoAction(ONE)).toEqual({ kind: "problem", problem: "unavailable" });
  });

  it.each(["suspended", "not_teacher", "not_editable"])("%s vuelve a la misma ruta", async (kind) => {
    mocks.renewVideoUpload.mockResolvedValue({ kind });
    await expect(renewVideoAction(ONE)).rejects.toThrow(`sale a ${BACK}`);
  });
});

describe("confirmVideoAction", () => {
  it("recibido: vuelve a leer el borrador", async () => {
    mocks.confirmVideo.mockResolvedValue({ kind: "uploaded" });
    expect(await confirmVideoAction(ONE)).toEqual({ kind: "uploaded" });
    expect(mocks.confirmVideo).toHaveBeenCalledWith(JAR, { course: COURSE, video: VIDEO });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it.each([
    ["type", "rejectedType"],
    ["size", "rejectedSize"],
    ["content", "rejectedContent"],
    ["duration", "rejectedDuration"],
    ["too_long", "rejectedTooLong"],
    [null, "rejectedContent"],
  ])("un rechazo por %s", async (reason, problem) => {
    mocks.confirmVideo.mockResolvedValue({ kind: "rejected", reason });
    expect(await confirmVideoAction(ONE)).toEqual({ kind: "problem", problem });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it.each([
    ["not_uploaded", "notUploaded"],
    ["unavailable", "unavailable"],
    ["unknown", "unavailable"],
    ["invalid", "unavailable"],
    ["expired", "expired"],
    ["not_found", "gone"],
  ])("%s se dice como %s", async (kind, problem) => {
    mocks.confirmVideo.mockResolvedValue({ kind });
    expect(await confirmVideoAction(ONE)).toEqual({ kind: "problem", problem });
  });

  it.each(["suspended", "not_teacher", "not_editable"])("%s vuelve a la misma ruta", async (kind) => {
    mocks.confirmVideo.mockResolvedValue({ kind });
    await expect(confirmVideoAction(ONE)).rejects.toThrow(`sale a ${BACK}`);
  });
});

describe("removeVideoAction", () => {
  it("quitado, y lo que ya no estaba también", async () => {
    for (const kind of ["deleted", "not_found"]) {
      mocks.removeVideo.mockResolvedValue({ kind });
      expect(await removeVideoAction(ONE)).toEqual({ kind: "removed" });
    }
    expect(mocks.removeVideo).toHaveBeenCalledWith(JAR, { course: COURSE, video: VIDEO });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("no se supo", async () => {
    mocks.removeVideo.mockResolvedValue({ kind: "unknown" });
    expect(await removeVideoAction(ONE)).toEqual({ kind: "problem", problem: "unavailable" });
  });

  it.each(["suspended", "not_teacher", "not_editable"])("%s vuelve a la misma ruta", async (kind) => {
    mocks.removeVideo.mockResolvedValue({ kind });
    await expect(removeVideoAction(ONE)).rejects.toThrow(`sale a ${BACK}`);
  });
});
