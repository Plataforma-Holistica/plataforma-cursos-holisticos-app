import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { VerifiedClaims } from "@/adapters/supabase/claims";

import type { ProviderAsset, VideoProvider } from "@/services/media/video-provider";

import { createDraftVideos, type DueVideo, type TrashedVideo, type VideosStore } from "./videos";

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
    due: vi.fn(() => Promise.resolve([])),
    claim: vi.fn(),
    createFailed: vi.fn(),
    created: vi.fn(),
    settle: vi.fn(),
    trashDue: vi.fn(() => Promise.resolve([])),
    trashDone: vi.fn(),
    ...overrides,
  };
  const signUpload = vi.fn(() => Promise.resolve("sign" in files ? files.sign : { endpoint: "http://x/sign", token: "firma" }));
  const facts = vi.fn(() => Promise.resolve("facts" in files ? files.facts : { contentOk: true, seconds: 90 }));
  const report = vi.fn(() => Promise.resolve());
  const checkSession = vi.fn(() => Promise.resolve({ kind: "pass", claims }));
  const service = createDraftVideos({
    store,
    files: { signUpload, facts, remove: vi.fn(), signForProvider: vi.fn() } as never,
    providers: { active: () => null, of: () => null },
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

describe("checkVideos", () => {
  const ASSET = "ASSET";
  const SINCE = 1_793_000_000;
  const row = (fields: Partial<DueVideo> = {}): DueVideo => ({ video: VIDEO, state: "uploaded", provider: "mux", asset: null, seconds: 90, current: false, ...fields });
  const READY: ProviderAsset = { state: "ready", playback: "PLAY", seconds: 91, captions: false, error: null };
  const CLAIMED = { answer: "claimed" as const, path: PATH, claim: "1793.5", retry: false, since: SINCE };

  function mux(overrides: Partial<VideoProvider> = {}): VideoProvider {
    return {
      create: vi.fn(() => Promise.resolve(ASSET)),
      read: vi.fn(() => Promise.resolve(READY)),
      findByPassthrough: vi.fn(() => Promise.resolve([])),
      remove: vi.fn(() => Promise.resolve(true)),
      ...overrides,
    };
  }

  function arrange(options: {
    due?: DueVideo[];
    store?: Partial<VideosStore>;
    provider?: VideoProvider;
    active?: "mux" | "test" | null;
    signed?: string | null;
    trash?: TrashedVideo[];
    filesRemove?: () => Promise<void>;
  } = {}) {
    const provider = options.provider ?? mux();
    const store: VideosStore = {
      begin: vi.fn(),
      file: vi.fn(),
      confirm: vi.fn(),
      remove: vi.fn(),
      due: vi.fn(() => Promise.resolve(options.due ?? [])),
      claim: vi.fn(() => Promise.resolve(CLAIMED)),
      createFailed: vi.fn(() => Promise.resolve("uploaded" as const)),
      created: vi.fn(() => Promise.resolve("processing" as const)),
      settle: vi.fn(() => Promise.resolve("ready" as const)),
      trashDue: vi.fn(() => Promise.resolve(options.trash ?? [])),
      trashDone: vi.fn(() => Promise.resolve("done" as const)),
      ...options.store,
    };
    const signForProvider = vi.fn(() => Promise.resolve(options.signed === undefined ? "https://firmada" : options.signed));
    const filesRemove = vi.fn(options.filesRemove ?? (() => Promise.resolve()));
    const report = vi.fn(() => Promise.resolve());
    const of = vi.fn((name: string | null) => (name === "mux" ? provider : null));
    const service = createDraftVideos({
      store,
      files: { signUpload: vi.fn(), facts: vi.fn(), remove: filesRemove, signForProvider },
      providers: { active: () => (options.active === undefined ? "mux" : options.active), of },
      checkSession: vi.fn(() => Promise.resolve({ kind: "pass", claims })) as never,
      report,
    });
    return { service, store, provider, signForProvider, filesRemove, report, of };
  }
  const check = (service: ReturnType<typeof createDraftVideos>) => service.checkVideos(reader, { course: COURSE });
  const quiet = { kind: "checked", changed: false, blocked: {} };

  it("corre la guarda, y lo que no tiene forma no llega a nadie", async () => {
    const { service, store } = arrange();
    expect(await service.checkVideos(reader, { course: "no" })).toEqual({ kind: "invalid" });
    expect(store.due).not.toHaveBeenCalled();
    const refused = { kind: "signed_out" };
    const service2 = createDraftVideos({
      store,
      files: {} as never,
      providers: { active: () => "mux", of: () => null },
      checkSession: vi.fn(() => Promise.resolve(refused)) as never,
      report: vi.fn(),
    });
    expect(await service2.checkVideos(reader, { course: COURSE })).toEqual({ kind: "session", check: refused });
    expect(store.due).not.toHaveBeenCalled();
  });

  it("sin nada que preguntar no llama al proveedor", async () => {
    const { service, provider, store } = arrange();
    expect(await check(service)).toEqual(quiet);
    expect(store.due).toHaveBeenCalledWith(claims, COURSE);
    expect(provider.read).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  describe("crear", () => {
    it("reclama, firma 6 h, crea con el id como passthrough y anota el asset, en ese orden", async () => {
      const order: string[] = [];
      const { service, store, signForProvider, provider } = arrange({
        due: [row()],
        store: {
          claim: vi.fn(() => (order.push("claim"), Promise.resolve(CLAIMED))),
          created: vi.fn(() => (order.push("created"), Promise.resolve("processing" as const))),
        },
        provider: mux({ create: vi.fn(() => (order.push("create"), Promise.resolve(ASSET))) }),
      });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(order).toEqual(["claim", "create", "created"]);
      expect(store.claim).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, provider: "mux" });
      expect(signForProvider).toHaveBeenCalledWith(PATH);
      expect(provider.create).toHaveBeenCalledWith({ url: "https://firmada", passthrough: VIDEO });
      expect(store.created).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, provider: "mux", asset: ASSET });
      expect(provider.findByPassthrough).not.toHaveBeenCalled();
    });

    it("sin proveedor activo no reclama nada: el video se queda en «Recibido» y no se gasta", async () => {
      const { service, store, provider } = arrange({ due: [row(), row({ state: "creating" })], active: null });
      expect(await check(service)).toEqual(quiet);
      expect(store.claim).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
    });

    it("un reclamo vencido también pasa por aquí", async () => {
      const { service, store } = arrange({ due: [row({ state: "creating" })] });
      await check(service);
      expect(store.claim).toHaveBeenCalledTimes(1);
    });

    it.each(["throttled", "over_minutes", "closed"] as const)("con %s no se llama a Mux, y se le dice a quien mira", async (answer) => {
      const { service, provider, signForProvider, store } = arrange({
        due: [row()],
        store: { claim: vi.fn(() => Promise.resolve({ answer, path: null, claim: null, retry: false, since: null })) },
      });
      expect(await check(service)).toEqual({ kind: "checked", changed: false, blocked: { [VIDEO]: answer } });
      expect(signForProvider).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.createFailed).not.toHaveBeenCalled();
    });

    it.each(["busy", "done", "not_found", "invalid", "unavailable", "not_editable", "suspended", "not_teacher"] as const)("con %s no se gasta nada y no se dice nada", async (answer) => {
      const { service, provider, store } = arrange({
        due: [row()],
        store: { claim: vi.fn(() => Promise.resolve({ answer, path: null, claim: null, retry: false, since: null })) },
      });
      expect(await check(service)).toEqual(quiet);
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.createFailed).not.toHaveBeenCalled();
    });

    it("si Mux no contesta, la fila vuelve a `uploaded` con su reclamo: el archivo no se pierde", async () => {
      const { service, store, report } = arrange({ due: [row()], provider: mux({ create: vi.fn(() => Promise.resolve(null)) }) });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(store.createFailed).toHaveBeenCalledWith(claims, { video: VIDEO, claim: CLAIMED.claim });
      expect(store.created).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith("video_provider_unavailable");
    });

    it("si no se pudo firmar tampoco se llama a Mux", async () => {
      const { service, store, provider, report } = arrange({ due: [row()], signed: null });
      await check(service);
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.createFailed).toHaveBeenCalledWith(claims, { video: VIDEO, claim: CLAIMED.claim });
      expect(report).toHaveBeenCalledWith("video_original_unavailable");
    });

    it("un reintento busca antes de crear, desde cuando nació la fila: un 5xx no dice que no lo haya creado", async () => {
      const retry = { ...CLAIMED, retry: true };
      const { service, provider, store } = arrange({ due: [row()], store: { claim: vi.fn(() => Promise.resolve(retry)) }, provider: mux({ findByPassthrough: vi.fn(() => Promise.resolve([ASSET])) }) });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(provider.findByPassthrough).toHaveBeenCalledWith(VIDEO, SINCE);
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.created).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, provider: "mux", asset: ASSET });
    });

    it("si la búsqueda no encontró nada, ahora sí crea", async () => {
      const { service, provider, store } = arrange({ due: [row()], store: { claim: vi.fn(() => Promise.resolve({ ...CLAIMED, retry: true })) } });
      await check(service);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(store.created).toHaveBeenCalledTimes(1);
    });

    it("si la búsqueda no pudo terminar NO crea: es la diferencia entre un reintento y pagar dos veces", async () => {
      const { service, provider, store, report } = arrange({
        due: [row()],
        store: { claim: vi.fn(() => Promise.resolve({ ...CLAIMED, retry: true })) },
        provider: mux({ findByPassthrough: vi.fn(() => Promise.resolve(null)) }),
      });
      await check(service);
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.createFailed).toHaveBeenCalledWith(claims, { video: VIDEO, claim: CLAIMED.claim });
      expect(report).toHaveBeenCalledWith("video_provider_unavailable");
    });

    it("dos con el mismo passthrough se anotan los dos: la base se queda con uno y manda el otro a la papelera", async () => {
      const { service, provider, store } = arrange({
        due: [row()],
        store: { claim: vi.fn(() => Promise.resolve({ ...CLAIMED, retry: true })) },
        provider: mux({ findByPassthrough: vi.fn(() => Promise.resolve(["UNO", "OTRO"])) }),
      });
      await check(service);
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.created).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, provider: "mux", asset: "UNO" });
      expect(store.created).toHaveBeenCalledWith(claims, { course: COURSE, video: VIDEO, provider: "mux", asset: "OTRO" });
    });

    it("un asset que sobra se borra en la misma pasada", async () => {
      const { service, provider, store } = arrange({
        due: [row()],
        store: {
          created: vi.fn(() => Promise.resolve("gone" as const)),
          trashDue: vi.fn(() => Promise.resolve([{ id: 7, provider: "mux", asset: ASSET, path: null }])),
        },
      });
      await check(service);
      expect(provider.remove).toHaveBeenCalledWith(ASSET);
      expect(store.trashDone).toHaveBeenCalledWith(claims, { course: COURSE, id: 7 });
    });

    it("si reclamar falla no se llama a Mux", async () => {
      const { service, provider, report } = arrange({ due: [row()], store: { claim: vi.fn(() => Promise.reject(new Error("la base"))) } });
      expect(await check(service)).toEqual({ kind: "unknown" });
      expect(provider.create).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith("draft_change_unavailable");
    });
  });

  describe("asentar lo que está procesando", () => {
    const processing = row({ state: "processing", asset: ASSET });

    it("listo: asienta la reproducción firmada, lo que midió Mux y los subtítulos", async () => {
      const { service, provider, store } = arrange({ due: [processing], provider: mux({ read: vi.fn(() => Promise.resolve({ ...READY, captions: true })) }) });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(provider.read).toHaveBeenCalledWith(ASSET, 90);
      expect(store.settle).toHaveBeenCalledWith(claims, { video: VIDEO, state: "ready", playback: "PLAY", seconds: 91, captions: true, error: null });
    });

    it("preparando no escribe nada", async () => {
      const { service, store, report } = arrange({ due: [processing], provider: mux({ read: vi.fn(() => Promise.resolve({ ...READY, state: "preparing" as const, playback: null, seconds: null })) }) });
      expect(await check(service)).toEqual(quiet);
      expect(store.settle).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    });

    it("con error asienta su tipo", async () => {
      const { service, store } = arrange({
        due: [processing],
        store: { settle: vi.fn(() => Promise.resolve("errored" as const)) },
        provider: mux({ read: vi.fn(() => Promise.resolve({ state: "errored" as const, playback: null, seconds: null, captions: false, error: "invalid_input" })) }),
      });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(store.settle).toHaveBeenCalledWith(claims, { video: VIDEO, state: "errored", playback: null, seconds: null, captions: false, error: "invalid_input" });
    });

    it("si Mux ya no lo tiene, queda con error", async () => {
      const { service, store } = arrange({ due: [processing], store: { settle: vi.fn(() => Promise.resolve("errored" as const)) }, provider: mux({ read: vi.fn(() => Promise.resolve("gone" as const)) }) });
      await check(service);
      expect(store.settle).toHaveBeenCalledWith(claims, { video: VIDEO, state: "errored", playback: null, seconds: null, captions: false, error: "provider_gone" });
    });

    it("sin reproducción firmada no se vuelve lista: una abierta no se anota nunca", async () => {
      const { service, store, report } = arrange({ due: [processing], store: { settle: vi.fn(() => Promise.resolve("errored" as const)) }, provider: mux({ read: vi.fn(() => Promise.resolve({ ...READY, playback: null })) }) });
      await check(service);
      expect(store.settle).toHaveBeenCalledWith(claims, { video: VIDEO, state: "errored", playback: null, seconds: null, captions: false, error: "not_signed" });
      expect(report).toHaveBeenCalledWith("video_provider_unavailable");
    });

    it("lista sin duración no se asienta: se vuelve a preguntar, y se avisa", async () => {
      const { service, store, report } = arrange({ due: [processing], provider: mux({ read: vi.fn(() => Promise.resolve({ ...READY, seconds: null })) }) });
      expect(await check(service)).toEqual(quiet);
      expect(store.settle).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith("video_provider_unavailable");
    });

    it("si no se supo no escribe, y no sigue preguntándole a Mux en esta pasada", async () => {
      const other = row({ state: "processing", asset: "OTRO", video: LESSON });
      const { service, store, provider, report } = arrange({ due: [processing, other], provider: mux({ read: vi.fn(() => Promise.resolve(null)) }) });
      expect(await check(service)).toEqual(quiet);
      expect(provider.read).toHaveBeenCalledTimes(1);
      expect(store.settle).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith("video_provider_unavailable");
    });

    it("una respuesta que la base no toma no cuenta como cambio", async () => {
      const { service } = arrange({ due: [processing], store: { settle: vi.fn(() => Promise.resolve("invalid" as const)) } });
      expect(await check(service)).toEqual(quiet);
    });

    it("una fila de un proveedor con el que no se puede hablar se salta, y las demás siguen", async () => {
      const other = row({ state: "processing", asset: "OTRO", video: LESSON });
      const { service, provider, store } = arrange({ due: [row({ state: "processing", asset: ASSET, provider: "ninguno" }), other] });
      await check(service);
      expect(provider.read).toHaveBeenCalledTimes(1);
      expect(provider.read).toHaveBeenCalledWith("OTRO", 90);
      expect(store.settle).toHaveBeenCalledTimes(1);
    });
  });

  describe("lo que ya está listo", () => {
    const ready = (fields: Partial<DueVideo> = {}) => row({ state: "ready", asset: ASSET, current: true, ...fields });

    it("llegaron los subtítulos: se anota", async () => {
      const { service, store } = arrange({ due: [ready()], provider: mux({ read: vi.fn(() => Promise.resolve({ ...READY, captions: true })) }) });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(store.settle).toHaveBeenCalledWith(claims, { video: VIDEO, state: "ready", playback: "PLAY", seconds: 91, captions: true, error: null });
    });

    it("la vigente sin subtítulos todavía: no escribe", async () => {
      const { service, store } = arrange({ due: [ready()] });
      expect(await check(service)).toEqual(quiet);
      expect(store.settle).not.toHaveBeenCalled();
    });

    it("una lista que no es la vigente: se asienta para que la base la promueva", async () => {
      const { service, store } = arrange({ due: [ready({ current: false })] });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(store.settle).toHaveBeenCalledTimes(1);
    });

    it("si Mux ya no la tiene o dice otra cosa, una lista no se toca", async () => {
      for (const read of ["gone" as const, { ...READY, state: "errored" as const, error: "x" }, { ...READY, playback: null }, { ...READY, seconds: null }]) {
        const { service, store } = arrange({ due: [ready({ current: false })], provider: mux({ read: vi.fn(() => Promise.resolve(read)) }) });
        expect(await check(service)).toEqual(quiet);
        expect(store.settle).not.toHaveBeenCalled();
      }
    });
  });

  describe("la papelera", () => {
    const item = { id: 7, provider: "mux", asset: ASSET, path: PATH };

    it("borra el asset y el archivo, y solo entonces la quita", async () => {
      const order: string[] = [];
      const { service, store, provider, filesRemove } = arrange({
        trash: [item],
        store: { trashDone: vi.fn(() => (order.push("done"), Promise.resolve("done" as const))) },
        provider: mux({ remove: vi.fn(() => (order.push("asset"), Promise.resolve(true))) }),
        filesRemove: () => (order.push("file"), Promise.resolve()),
      });
      expect(await check(service)).toEqual(quiet);
      expect(order).toEqual(["asset", "file", "done"]);
      expect(store.trashDue).toHaveBeenCalledWith(claims, COURSE);
      expect(provider.remove).toHaveBeenCalledWith(ASSET);
      expect(filesRemove).toHaveBeenCalledWith([PATH]);
      expect(store.trashDone).toHaveBeenCalledWith(claims, { course: COURSE, id: 7 });
    });

    it("lo que no tiene asset no le pregunta al proveedor, y lo que no tiene archivo no toca la cubeta", async () => {
      const onlyFile = arrange({ trash: [{ id: 1, provider: "mux", asset: null, path: PATH }] });
      await check(onlyFile.service);
      expect(onlyFile.provider.remove).not.toHaveBeenCalled();
      expect(onlyFile.filesRemove).toHaveBeenCalledWith([PATH]);
      const onlyAsset = arrange({ trash: [{ id: 2, provider: "mux", asset: ASSET, path: null }] });
      await check(onlyAsset.service);
      expect(onlyAsset.filesRemove).not.toHaveBeenCalled();
      expect(onlyAsset.store.trashDone).toHaveBeenCalledTimes(1);
    });

    it("si Mux no lo borró, no toca el archivo y no sale de la papelera: se reintenta, y cualquier otra sigue", async () => {
      const { service, store, filesRemove, report } = arrange({
        trash: [item, { id: 8, provider: "mux", asset: null, path: "otra" }],
        provider: mux({ remove: vi.fn(() => Promise.resolve(false)) }),
      });
      expect(await check(service)).toEqual(quiet);
      expect(filesRemove).toHaveBeenCalledTimes(1);
      expect(filesRemove).toHaveBeenCalledWith(["otra"]);
      expect(store.trashDone).toHaveBeenCalledTimes(1);
      expect(store.trashDone).toHaveBeenCalledWith(claims, { course: COURSE, id: 8 });
      expect(report).toHaveBeenCalledWith("video_cleanup_failed");
    });

    it("si la cubeta falló, tampoco sale", async () => {
      const { service, store, report } = arrange({ trash: [item], filesRemove: () => Promise.reject(new Error("storage")) });
      expect(await check(service)).toEqual(quiet);
      expect(store.trashDone).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith("video_cleanup_failed");
    });

    it("sin llaves para un asset de Mux, espera sin borrar el archivo ni avisar: solo pasa en una máquina de desarrollo", async () => {
      const { service, store, filesRemove, report } = arrange({ trash: [{ ...item, provider: "otro" }] });
      await check(service);
      expect(filesRemove).not.toHaveBeenCalled();
      expect(store.trashDone).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    });

    it("una falla de la limpieza no tumba lo que ya se hizo", async () => {
      const { service, report } = arrange({ due: [row()], store: { trashDue: vi.fn(() => Promise.reject(new Error("la base"))) } });
      expect(await check(service)).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(report).toHaveBeenCalledWith("video_cleanup_failed");
    });

    it("confirmar con rechazo y quitar la vacían; lo que no borró nada, no", async () => {
      const rejected = arrange({ trash: [item], store: { file: vi.fn(() => Promise.resolve({ answer: "not_found" as const, path: null, mime: null })), confirm: vi.fn(() => Promise.resolve({ answer: "rejected" as const, reason: "type" as const })) } });
      await rejected.service.confirmVideo(reader, { course: COURSE, video: VIDEO });
      expect(rejected.store.trashDue).toHaveBeenCalledWith(claims, COURSE);

      const expired = arrange({ store: { file: vi.fn(() => Promise.resolve({ answer: "not_found" as const, path: null, mime: null })), confirm: vi.fn(() => Promise.resolve({ answer: "expired" as const, reason: null })) } });
      await expired.service.confirmVideo(reader, { course: COURSE, video: VIDEO });
      expect(expired.store.trashDue).toHaveBeenCalledWith(claims, COURSE);

      const uploaded = arrange({ store: { file: vi.fn(() => Promise.resolve({ answer: "not_found" as const, path: null, mime: null })), confirm: vi.fn(() => Promise.resolve({ answer: "uploaded" as const, reason: null })) } });
      await uploaded.service.confirmVideo(reader, { course: COURSE, video: VIDEO });
      expect(uploaded.store.trashDue).not.toHaveBeenCalled();

      const removed = arrange({ store: { remove: vi.fn(() => Promise.resolve("deleted" as const)) } });
      await removed.service.removeVideo(reader, { course: COURSE, video: VIDEO });
      expect(removed.store.trashDue).toHaveBeenCalledWith(claims, COURSE);

      const missing = arrange({ store: { remove: vi.fn(() => Promise.resolve("not_found" as const)) } });
      await missing.service.removeVideo(reader, { course: COURSE, video: VIDEO });
      expect(missing.store.trashDue).not.toHaveBeenCalled();
    });

    it("una falla al vaciar después de quitar no cambia lo que se contesta", async () => {
      const { service, report } = arrange({ store: { remove: vi.fn(() => Promise.resolve("deleted" as const)), trashDue: vi.fn(() => Promise.reject(new Error("la base"))) } });
      expect(await service.removeVideo(reader, { course: COURSE, video: VIDEO })).toEqual({ kind: "deleted" });
      expect(report).toHaveBeenCalledWith("video_cleanup_failed");
    });

    it("`cleanUp` es lo que corre al borrar una lección, un módulo o un curso", async () => {
      const { service, store } = arrange({ trash: [item] });
      await service.cleanUp(claims, COURSE);
      expect(store.trashDone).toHaveBeenCalledWith(claims, { course: COURSE, id: 7 });
    });
  });
});
