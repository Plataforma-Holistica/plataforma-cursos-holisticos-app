import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción de PA-44 (T-405), con los servicios simulados: qué le pasa a cada servicio y qué hace con cada respuesta. Lo que el servicio hace de verdad lo prueban
// tests/integration/97-enviar.test.ts y el extremo a extremo.

const mocks = vi.hoisted(() => ({
  submitCourse: vi.fn(),
  removeResource: vi.fn(),
  refresh: vi.fn(),
  leaveFor: vi.fn((_jar: unknown, outcome: { to: string }) => {
    throw new Error(`sale a ${outcome.to}`);
  }),
  cookieJar: vi.fn(() => Promise.resolve({ jar: true })),
  requestOrigin: vi.fn(() => Promise.resolve({ realIp: "203.0.113.7", userAgent: "Navegador" })),
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar, requestOrigin: mocks.requestOrigin }));
vi.mock("@/app/(cuenta)/_lib/exit", () => ({ leaveFor: mocks.leaveFor }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
vi.mock("@/services/drafts/editor", () => ({ submitCourse: mocks.submitCourse, removeResource: mocks.removeResource }));

const { submitCourseAction } = await import("@/app/portal/_enviar/actions");
const { ACCEPT_FIELD, ACCEPT_VALUE, removePendingButton, submitButton } = await import("@/app/portal/_enviar/outcomes");

const COURSE = "c0000000-0000-4000-8000-000000000001";
const ANNEX = "a1000000-0000-4000-8000-000000000002";
const RESOURCE = "e0000000-0000-4000-8000-000000000003";
const JAR = { jar: true };
const SEEN = { course: COURSE, annex: ANNEX, seen: "d".repeat(64), term: 10, submission: 1 };
const IDLE = { kind: "idle" } as const;

const form = (entries: [string, string][]) => {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
};
const accepted = () => form([["do", submitButton(SEEN)], [ACCEPT_FIELD, ACCEPT_VALUE]]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitCourseAction", () => {
  it("un envío vacío no llama a nadie", async () => {
    expect(await submitCourseAction(IDLE, new FormData())).toEqual(IDLE);
    expect(mocks.submitCourse).not.toHaveBeenCalled();
  });

  it("le pasa al servicio lo que se vio, la casilla y el origen de la petición; enviado, a Mis cursos", async () => {
    mocks.submitCourse.mockResolvedValueOnce({ kind: "submitted" });
    await expect(submitCourseAction(IDLE, accepted())).rejects.toThrow("sale a /portal/cursos");
    expect(mocks.submitCourse).toHaveBeenCalledWith(JAR, { ...SEEN, accepted: true }, { realIp: "203.0.113.7", userAgent: "Navegador" });
    expect(mocks.leaveFor).toHaveBeenCalledWith(JAR, expect.objectContaining({ notice: "course_submitted" }));
  });

  it("sin la casilla se dice, y la página no se vuelve a pedir: no cambió nada", async () => {
    mocks.submitCourse.mockResolvedValueOnce({ kind: "not_accepted" });
    expect(await submitCourseAction(IDLE, form([["do", submitButton(SEEN)]]))).toEqual({ kind: "failed", reason: "not_accepted", lessons: [], attempt: 1 });
    expect(mocks.submitCourse).toHaveBeenCalledWith(JAR, { ...SEEN, accepted: false }, expect.anything());
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("lo demás se dice, con las lecciones si las hay, y la página se vuelve a pedir: el curso pudo cambiar", async () => {
    mocks.submitCourse.mockResolvedValueOnce({ kind: "video_not_ready", lessons: ["l1"] });
    expect(await submitCourseAction(IDLE, accepted())).toEqual({ kind: "failed", reason: "video_not_ready", lessons: ["l1"], attempt: 1 });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("quitar un recurso pendiente pasa por el servicio de los recursos, con su revisión; quitado, se dice", async () => {
    mocks.removeResource.mockResolvedValueOnce({ kind: "deleted" });
    expect(await submitCourseAction(IDLE, form([["do", removePendingButton(COURSE, RESOURCE, 4)]]))).toEqual({ kind: "removed", attempt: 1 });
    expect(mocks.removeResource).toHaveBeenCalledWith(JAR, { course: COURSE, resource: RESOURCE, seen: 4 });
    expect(mocks.submitCourse).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("lo que ya no estaba cuenta como quitado, y lo que no se supo se dice así", async () => {
    mocks.removeResource.mockResolvedValueOnce({ kind: "not_found" });
    expect(await submitCourseAction(IDLE, form([["do", removePendingButton(COURSE, RESOURCE, 4)]]))).toEqual({ kind: "removed", attempt: 1 });
    mocks.removeResource.mockResolvedValueOnce({ kind: "unknown" });
    expect(await submitCourseAction(IDLE, form([["do", removePendingButton(COURSE, RESOURCE, 4)]]))).toEqual({ kind: "failed", reason: "remove_unknown", lessons: [], attempt: 1 });
  });

  it("si quitar no se pudo, lo dice con sus propias palabras", async () => {
    mocks.removeResource.mockResolvedValueOnce({ kind: "changed" });
    expect(await submitCourseAction(IDLE, form([["do", removePendingButton(COURSE, RESOURCE, 4)]]))).toEqual({ kind: "failed", reason: "remove_changed", lessons: [], attempt: 1 });
  });
});
