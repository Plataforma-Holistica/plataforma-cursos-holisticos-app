import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { createDraftVideos, type VideosStore } from "./videos";

const COURSE = "11111111-1111-4111-8111-111111111111";
const LESSON = "22222222-2222-4222-8222-222222222222";
const VIDEO = "33333333-3333-4333-8333-333333333333";
const PATH = `t/${COURSE}/${VIDEO}`;
const claims = { sub: "persona" } as unknown as VerifiedClaims;
const reader = { get: () => undefined };
const ANSWER = { course: COURSE, lesson: LESSON, fileName: "clase.mp4", size: 1000 };

function setup(overrides: Partial<VideosStore> = {}, files: { sign?: unknown; facts?: unknown } = {}) {
  const store: VideosStore = {
    begin: vi.fn(() => Promise.resolve({ answer: "started" as const, video: VIDEO, path: PATH, fileName: null })),
    file: vi.fn(() => Promise.resolve({ answer: "ok" as const, path: PATH, mime: "video/mp4" })),
    confirm: vi.fn(() => Promise.resolve({ answer: "uploaded" as const, reason: null })),
    remove: vi.fn(() => Promise.resolve("deleted" as const)),
    ...overrides,
  };
  const signUpload = vi.fn(() => Promise.resolve("sign" in files ? files.sign : { endpoint: "http://x/sign", token: "firma" }));
  const facts = vi.fn(() => Promise.resolve("facts" in files ? files.facts : { contentOk: true, seconds: 90 }));
  const report = vi.fn(() => Promise.resolve());
  const checkSession = vi.fn(() => Promise.resolve({ kind: "pass", claims }));
  const service = createDraftVideos({
    store,
    files: { signUpload, facts, remove: vi.fn() } as never,
    checkSession: checkSession as never,
    report,
  });
  return { service, store, signUpload, facts, report, checkSession };
}

describe("beginVideo", () => {
  it("reserva y firma la ruta que contestó la base", async () => {
    const { service, store, signUpload } = setup();
    expect(await service.beginVideo(reader, ANSWER)).toEqual({
      kind: "go",
      video: VIDEO,
      path: PATH,
      mime: "video/mp4",
      bucket: "video-originals",
      endpoint: "http://x/sign",
      token: "firma",
      resumed: false,
    });
    expect(store.begin).toHaveBeenCalledWith(claims, { course: COURSE, lesson: LESSON, fileName: "clase.mp4", mime: "video/mp4", size: 1000 });
    expect(signUpload).toHaveBeenCalledWith(PATH);
  });

  it("el tipo sale de la extensión, y lo que no tiene forma no llega a nadie", async () => {
    for (const input of [
      { ...ANSWER, fileName: "clase.mkv" },
      { ...ANSWER, course: "no" },
      { ...ANSWER, lesson: "no" },
      { ...ANSWER, size: 0 },
      { ...ANSWER, size: 1.5 },
      { ...ANSWER, size: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const { service, store, checkSession } = setup();
      expect(await service.beginVideo(reader, input)).toEqual({ kind: "invalid" });
      expect(store.begin).not.toHaveBeenCalled();
      expect(checkSession).not.toHaveBeenCalled();
    }
    const mov = setup();
    await mov.service.beginVideo(reader, { ...ANSWER, fileName: "CLASE.MOV" });
    expect(mov.store.begin).toHaveBeenCalledWith(claims, expect.objectContaining({ mime: "video/quicktime" }));
  });

  it("una subida a medias del mismo archivo se reanuda, también firmando", async () => {
    const { service } = setup({ begin: vi.fn(() => Promise.resolve({ answer: "resumed" as const, video: VIDEO, path: PATH, fileName: null })) });
    expect(await service.beginVideo(reader, ANSWER)).toMatchObject({ kind: "go", video: VIDEO, token: "firma", resumed: true });
  });

  it("si no se pudo firmar lo recién nacido se cancela y se reporta", async () => {
    const { service, store, report } = setup({}, { sign: null });
    expect(await service.beginVideo(reader, ANSWER)).toEqual({ kind: "unknown" });
    expect(store.remove).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO });
    expect(report).toHaveBeenCalledWith("video_upload_unavailable");
  });

  it("si no se pudo firmar una a medias no se toca: lleva horas subiendo", async () => {
    const { service, store, report } = setup({ begin: vi.fn(() => Promise.resolve({ answer: "resumed" as const, video: VIDEO, path: PATH, fileName: null })) }, { sign: null });
    expect(await service.beginVideo(reader, ANSWER)).toEqual({ kind: "unknown" });
    expect(store.remove).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("video_upload_unavailable");
  });

  it("otra subida a medias: dice de qué archivo", async () => {
    const { service, signUpload } = setup({ begin: vi.fn(() => Promise.resolve({ answer: "pending" as const, video: VIDEO, path: null, fileName: "otro.mp4" })) });
    expect(await service.beginVideo(reader, ANSWER)).toEqual({ kind: "pending", video: VIDEO, fileName: "otro.mp4" });
    expect(signUpload).not.toHaveBeenCalled();
  });

  it("lo demás se contesta tal cual, sin firmar", async () => {
    for (const answer of ["busy", "closed", "throttled", "too_large", "invalid", "unavailable", "not_found", "not_editable", "suspended", "not_teacher"] as const) {
      const { service, signUpload } = setup({ begin: vi.fn(() => Promise.resolve({ answer, video: null, path: null, fileName: null })) });
      expect(await service.beginVideo(reader, ANSWER)).toEqual({ kind: answer });
      expect(signUpload).not.toHaveBeenCalled();
    }
  });

  it("sin sesión no pregunta, y una falla se reporta como no se supo", async () => {
    const out = setup();
    out.checkSession.mockResolvedValueOnce({ kind: "no_session" } as never);
    expect(await out.service.beginVideo(reader, ANSWER)).toEqual({ kind: "session", check: { kind: "no_session" } });
    expect(out.store.begin).not.toHaveBeenCalled();
    const broken = setup({ begin: vi.fn(() => Promise.reject(new Error("caída"))) });
    expect(await broken.service.beginVideo(reader, ANSWER)).toEqual({ kind: "unknown" });
    expect(broken.report).toHaveBeenCalledWith("draft_change_unavailable");
  });
});

describe("renewVideoUpload", () => {
  it("vuelve a preguntar a la base, y firma la ruta que ella contesta", async () => {
    const { service, store, signUpload } = setup();
    expect(await service.renewVideoUpload(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "renewed", token: "firma" });
    expect(store.file).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO });
    expect(signUpload).toHaveBeenCalledWith(PATH);
  });

  it("quien ya no puede, o un video que ya no sube, no recibe firma", async () => {
    for (const answer of ["not_found", "not_editable", "suspended", "not_teacher"] as const) {
      const { service, signUpload } = setup({ file: vi.fn(() => Promise.resolve({ answer, path: null, mime: null })) });
      expect(await service.renewVideoUpload(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: answer });
      expect(signUpload).not.toHaveBeenCalled();
    }
  });

  it("sin firma lo dice y lo reporta", async () => {
    const { service, report } = setup({}, { sign: null });
    expect(await service.renewVideoUpload(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "unknown" });
    expect(report).toHaveBeenCalledWith("video_upload_unavailable");
  });
});

describe("confirmVideo", () => {
  it("lee el archivo y le pasa a la base lo que leyó", async () => {
    const { service, store, facts } = setup();
    expect(await service.confirmVideo(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "uploaded" });
    expect(facts).toHaveBeenCalledWith(PATH, "video/mp4");
    expect(store.confirm).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, contentOk: true, seconds: 90 });
  });

  it("lo que no se pudo leer viaja nulo: la base no lo toma como rechazo", async () => {
    const { service, store } = setup({ confirm: vi.fn(() => Promise.resolve({ answer: "unavailable" as const, reason: null })) }, { facts: { contentOk: null, seconds: null } });
    expect(await service.confirmVideo(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "unavailable" });
    expect(store.confirm).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, contentOk: null, seconds: null });
  });

  it("un rechazo dice la razón", async () => {
    for (const reason of ["type", "size", "content", "duration", "too_long"] as const) {
      const { service } = setup({ confirm: vi.fn(() => Promise.resolve({ answer: "rejected" as const, reason })) });
      expect(await service.confirmVideo(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "rejected", reason });
    }
  });

  it("un video que ya no está subiendo no se lee: la base dice si ya quedó o ya no existe", async () => {
    const { service, store, facts } = setup({ file: vi.fn(() => Promise.resolve({ answer: "not_found" as const, path: null, mime: null })) });
    expect(await service.confirmVideo(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "uploaded" });
    expect(facts).not.toHaveBeenCalled();
    expect(store.confirm).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, contentOk: null, seconds: null });
  });

  it("quien ya no puede editar no llega a leer ni a confirmar", async () => {
    for (const answer of ["not_editable", "suspended", "not_teacher"] as const) {
      const { service, store, facts } = setup({ file: vi.fn(() => Promise.resolve({ answer, path: null, mime: null })) });
      expect(await service.confirmVideo(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: answer });
      expect(facts).not.toHaveBeenCalled();
      expect(store.confirm).not.toHaveBeenCalled();
    }
  });
});

describe("removeVideo", () => {
  it("le pregunta a la base", async () => {
    const { service, store } = setup();
    expect(await service.removeVideo(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "deleted" });
    expect(store.remove).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO });
  });

  it("lo que no tiene forma no llega", async () => {
    const { service, store } = setup();
    expect(await service.removeVideo(reader, { course: COURSE, video: "no" })).toEqual({ kind: "invalid" });
    expect(store.remove).not.toHaveBeenCalled();
  });
});
