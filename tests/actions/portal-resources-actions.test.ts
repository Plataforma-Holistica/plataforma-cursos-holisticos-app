import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de los recursos (T-404; PA-43), con los servicios simulados: qué le pasa a cada servicio y qué hace con
// cada respuesta. Lo que el servicio hace de verdad lo prueban tests/integration/90-recursos.test.ts y el extremo a extremo.

const mocks = vi.hoisted(() => ({
  beginResource: vi.fn(),
  confirmResource: vi.fn(),
  moveResource: vi.fn(),
  removeResource: vi.fn(),
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
  beginResource: mocks.beginResource,
  confirmResource: mocks.confirmResource,
  moveResource: mocks.moveResource,
  removeResource: mocks.removeResource,
}));

const { beginResourceAction, cancelResourceAction, confirmResourceAction, resourceAction } = await import("@/app/portal/_editor/resource-actions");

const COURSE = "c0000000-0000-4000-8000-000000000001";
const LESSON = "e0000000-0000-4000-8000-000000000001";
const RESOURCE = "f0000000-0000-4000-8000-000000000001";
const JAR = { jar: true };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}
const IDLE = { kind: "idle" } as const;
const BEGIN = { course: COURSE, lesson: LESSON, title: "Guía", fileName: "guia.pdf", size: 10 };
const CONFIRM = { course: COURSE, lesson: LESSON, resource: RESOURCE };

beforeEach(() => vi.clearAllMocks());

describe("la lista", () => {
  it("lo que no es un formulario, o sin intención, no llama a nadie", async () => {
    expect(await resourceAction(IDLE, null as unknown as FormData)).toEqual(IDLE);
    expect(await resourceAction(IDLE, form({ course: COURSE }))).toEqual(IDLE);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it("preguntar y cancelar no llaman a nadie", async () => {
    expect(await resourceAction(IDLE, form({ course: COURSE, do: `resource-ask:${RESOURCE}` }))).toEqual({ kind: "confirming", resource: RESOURCE, attempt: 1 });
    expect(await resourceAction(IDLE, form({ course: COURSE, do: "cancel" }))).toEqual({ kind: "kept", attempt: 1 });
    expect(mocks.removeResource).not.toHaveBeenCalled();
  });

  it("quitar lleva lo que se vio, vuelve a leer y lo dice", async () => {
    mocks.removeResource.mockResolvedValue({ kind: "deleted" });
    expect(await resourceAction(IDLE, form({ course: COURSE, do: `resource-remove:${RESOURCE}:4` }))).toEqual({ kind: "done", what: "removed", attempt: 1 });
    expect(mocks.removeResource).toHaveBeenCalledExactlyOnceWith(JAR, { course: COURSE, resource: RESOURCE, seen: 4 });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("mover lleva la posición que se vio", async () => {
    mocks.moveResource.mockResolvedValue({ kind: "moved" });
    expect(await resourceAction(IDLE, form({ course: COURSE, do: `resource-move:${RESOURCE}:2:1` }))).toEqual({ kind: "done", what: "moved", attempt: 1 });
    expect(mocks.moveResource).toHaveBeenCalledExactlyOnceWith(JAR, { course: COURSE, resource: RESOURCE, seenPosition: 2, toPosition: 1 });
  });

  it("si cambió, lo dice y vuelve a leer", async () => {
    mocks.removeResource.mockResolvedValue({ kind: "changed" });
    expect(await resourceAction(IDLE, form({ course: COURSE, do: `resource-remove:${RESOURCE}:4` }))).toEqual({ kind: "failed", reason: "changed", attempt: 1 });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("quien ya no puede editar vuelve a la misma pantalla, con lo elegido", async () => {
    mocks.removeResource.mockResolvedValue({ kind: "suspended" });
    await expect(resourceAction(IDLE, form({ course: COURSE, lesson: LESSON, do: `resource-remove:${RESOURCE}:4` }))).rejects.toThrow(`sale a /portal/cursos/${COURSE}?leccion=${LESSON}`);
  });
});

describe("empezar", () => {
  it("le pasa al servicio lo que llegó y contesta la dirección", async () => {
    mocks.beginResource.mockResolvedValue({ kind: "started", resource: RESOURCE, url: "https://storage/subir", mime: "application/pdf" });
    expect(await beginResourceAction(BEGIN)).toEqual({ kind: "go", resource: RESOURCE, url: "https://storage/subir", mime: "application/pdf" });
    expect(mocks.beginResource).toHaveBeenCalledExactlyOnceWith(JAR, BEGIN);
  });

  it.each([
    ["too_large", "fileSize"],
    ["too_many", "tooMany"],
    ["throttled", "throttled"],
    ["unavailable", "unavailable"],
    ["unknown", "unavailable"],
    ["invalid", "unavailable"],
    ["not_found", "gone"],
  ])("%s se dice como %s", async (kind, problem) => {
    mocks.beginResource.mockResolvedValue({ kind });
    expect(await beginResourceAction(BEGIN)).toEqual({ kind: "problem", problem });
  });

  it.each(["too_many", "not_found"])("con %s la lista pudo cambiar: vuelve a leer", async (kind) => {
    mocks.beginResource.mockResolvedValue({ kind });
    await beginResourceAction(BEGIN);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it.each(["suspended", "not_teacher", "not_editable"])("con %s vuelve a la misma pantalla", async (kind) => {
    mocks.beginResource.mockResolvedValue({ kind });
    await expect(beginResourceAction(BEGIN)).rejects.toThrow(`sale a /portal/cursos/${COURSE}?leccion=${LESSON}`);
  });

  it("sin sesión va a entrar y vuelve a donde estaba", async () => {
    mocks.beginResource.mockResolvedValue({ kind: "session", check: { kind: "anonymous" } });
    await expect(beginResourceAction(BEGIN)).rejects.toThrow(/sale a \/entrar/);
  });

  it.each([
    ["nulo", null],
    ["un texto", "x"],
    ["tipos cruzados", { course: 1, lesson: 2, title: {}, fileName: [], size: "9" }],
  ])("lo que llega puede no ser lo que este código armó (%s): cuenta como vacío, y lo revisa el servicio", async (_name, input) => {
    mocks.beginResource.mockResolvedValue({ kind: "invalid" });
    expect(await beginResourceAction(input as never)).toEqual({ kind: "problem", problem: "unavailable" });
    const [, sent] = mocks.beginResource.mock.calls[0] as [unknown, { course: string; title: string; fileName: string; size: number }];
    expect(sent).toMatchObject({ course: "", title: "", fileName: "", size: 0 });
  });
});

describe("confirmar", () => {
  it("listo: vuelve a leer el borrador", async () => {
    mocks.confirmResource.mockResolvedValue({ kind: "ready" });
    expect(await confirmResourceAction(CONFIRM)).toEqual({ kind: "ready" });
    expect(mocks.confirmResource).toHaveBeenCalledExactlyOnceWith(JAR, { course: COURSE, resource: RESOURCE });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ["type", "rejectedType"],
    ["size", "rejectedSize"],
    ["content", "rejectedContent"],
  ])("rechazado por %s se dice como %s", async (reason, problem) => {
    mocks.confirmResource.mockResolvedValue({ kind: "rejected", reason });
    expect(await confirmResourceAction(CONFIRM)).toEqual({ kind: "problem", problem });
  });

  it.each([
    ["expired", "expired"],
    ["not_uploaded", "notUploaded"],
    ["unavailable", "unavailable"],
    ["unknown", "unavailable"],
    ["invalid", "unavailable"],
    ["not_found", "gone"],
  ])("%s se dice como %s", async (kind, problem) => {
    mocks.confirmResource.mockResolvedValue({ kind });
    expect(await confirmResourceAction(CONFIRM)).toEqual({ kind: "problem", problem });
  });

  it("con nulo no lanza", async () => {
    mocks.confirmResource.mockResolvedValue({ kind: "invalid" });
    expect(await confirmResourceAction(null as never)).toEqual({ kind: "problem", problem: "unavailable" });
  });
});

describe("cancelar", () => {
  it("quita la fila que acaba de nacer", async () => {
    mocks.removeResource.mockResolvedValue({ kind: "deleted" });
    await cancelResourceAction({ course: COURSE, resource: RESOURCE });
    expect(mocks.removeResource).toHaveBeenCalledExactlyOnceWith(JAR, { course: COURSE, resource: RESOURCE, seen: 1 });
  });

  it("con nulo no lanza", async () => {
    mocks.removeResource.mockResolvedValue({ kind: "invalid" });
    await expect(cancelResourceAction(null as never)).resolves.toBeUndefined();
  });
});
