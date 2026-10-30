import { describe, expect, it, vi } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

import { createDrafts, type DraftsStore } from "./drafts";

vi.mock("server-only", () => ({}));

// El servicio del borrador con su almacén simulado: qué llega a la base, en qué orden y qué se
// contesta. Contra la base de verdad, en tests/integration/72-borrador.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const reader = {} as CookieReader;
const COURSE = "c0000000-0000-4000-8000-000000000001";
const MODULE = "d0000000-0000-4000-8000-000000000001";
const OTHER_MODULE = "d0000000-0000-4000-8000-000000000002";
const LESSON = "e0000000-0000-4000-8000-000000000001";
const PRACTICE = "f0000000-0000-4000-8000-000000000001";
const TOKEN = "b0000000-0000-4000-8000-000000000001";

function setup(session: SessionCheck = { kind: "pass", claims }) {
  const reported: FailureCode[] = [];
  const store: DraftsStore = {
    teacherCourses: vi.fn(() => Promise.resolve([])),
    draftCourse: vi.fn(() => Promise.resolve(null)),
    create: vi.fn(() => Promise.resolve({ answer: "created" as const, id: COURSE })),
    saveCourse: vi.fn(() => Promise.resolve("saved" as const)),
    addModule: vi.fn(() => Promise.resolve({ answer: "created" as const, id: MODULE })),
    renameModule: vi.fn(() => Promise.resolve("saved" as const)),
    deleteModule: vi.fn(() => Promise.resolve("deleted" as const)),
    moveModule: vi.fn(() => Promise.resolve("moved" as const)),
    addLesson: vi.fn(() => Promise.resolve({ answer: "created" as const, id: LESSON })),
    saveLesson: vi.fn(() => Promise.resolve("saved" as const)),
    deleteLesson: vi.fn(() => Promise.resolve("deleted" as const)),
    moveLesson: vi.fn(() => Promise.resolve("moved" as const)),
    deleteCourse: vi.fn(() => Promise.resolve("deleted" as const)),
    choices: vi.fn(() => Promise.resolve({ practices: [], levels: [] })),
  };
  const checkSession = vi.fn<(reader: CookieReader) => Promise<SessionCheck>>(() => Promise.resolve(session));
  const service = createDrafts({ store, checkSession, report: (code) => (reported.push(code), Promise.resolve()) });
  return { ...service, store, checkSession, reported };
}

describe("cambiar el borrador", () => {
  it("crea con el título ya revisado y a nombre de la sesión que pasó", async () => {
    const service = setup();
    expect(await service.createCourse(reader, { token: TOKEN, title: "  Respirar\u0301  " })).toEqual({ kind: "created", id: COURSE });
    expect(service.checkSession).toHaveBeenCalledExactlyOnceWith(reader);
    expect(service.store.create).toHaveBeenCalledExactlyOnceWith(claims, TOKEN, "Respirar\u0301".normalize("NFC"));
  });

  it.each([
    ["un título vacío", () => setup().createCourse(reader, { token: TOKEN, title: "  " })],
    ["un testigo sin forma", () => setup().createCourse(reader, { token: "otro", title: "Respirar" })],
    ["un título largo", () => setup().createCourse(reader, { token: TOKEN, title: "a".repeat(61) })],
    ["un curso sin forma", () => setup().saveCourse(reader, { course: "x", seen: 1, title: "T", summary: null, practiceId: null, levelId: null })],
    ["una revisión cero", () => setup().saveCourse(reader, { course: COURSE, seen: 0, title: "T", summary: null, practiceId: null, levelId: null })],
    ["una práctica sin forma", () => setup().saveCourse(reader, { course: COURSE, seen: 1, title: "T", summary: null, practiceId: "x", levelId: null })],
    ["un resumen largo", () => setup().saveCourse(reader, { course: COURSE, seen: 1, title: "T", summary: "r".repeat(501), practiceId: null, levelId: null })],
    ["una posición no entera", () => setup().moveModule(reader, { course: COURSE, module: MODULE, seenPosition: 1.5, toPosition: 1 })],
    ["un módulo destino sin forma", () =>
      setup().moveLesson(reader, { course: COURSE, lesson: LESSON, seen: { module: MODULE, position: 1 }, to: { module: "x", position: 1 } })],
    ["una descripción con un carácter que no se ve", () =>
      setup().saveLesson(reader, { course: COURSE, lesson: LESSON, seen: 1, title: "T", description: "a\u200bb" })],
  ])("con %s contesta invalid sin preguntarle a nadie", async (_name, call) => {
    expect(await call()).toEqual({ kind: "invalid" });
  });

  it("lo que no tiene forma no corre ni la guarda", async () => {
    const service = setup();
    await service.addModule(reader, { course: COURSE, seen: 1, title: "" });
    expect(service.checkSession).not.toHaveBeenCalled();
    expect(service.store.addModule).not.toHaveBeenCalled();
  });

  it("guarda los datos con el resumen vacío como nulo", async () => {
    const service = setup();
    await service.saveCourse(reader, { course: COURSE, seen: 3, title: "Respirar", summary: " ", practiceId: PRACTICE, levelId: null });
    expect(service.store.saveCourse).toHaveBeenCalledExactlyOnceWith(claims, COURSE, 3, {
      title: "Respirar",
      summary: null,
      practiceId: PRACTICE,
      levelId: null,
    });
  });

  it("pasa a la base lo que se vio al mover una lección", async () => {
    const service = setup();
    const seen = { module: MODULE, position: 2 };
    const to = { module: OTHER_MODULE, position: 1 };
    expect(await service.moveLesson(reader, { course: COURSE, lesson: LESSON, seen, to })).toEqual({ kind: "moved" });
    expect(service.store.moveLesson).toHaveBeenCalledExactlyOnceWith(claims, COURSE, LESSON, seen, to);
  });

  it("contesta lo que dijo la guarda si no pasa, sin escribir", async () => {
    const check = { kind: "suspended" } as unknown as SessionCheck;
    const service = setup(check);
    expect(await service.deleteCourse(reader, { course: COURSE, seen: 1 })).toEqual({ kind: "session", check });
    expect(service.store.deleteCourse).not.toHaveBeenCalled();
  });

  it("contesta lo que dijo la base", async () => {
    const service = setup();
    vi.mocked(service.store.saveLesson).mockResolvedValueOnce("changed");
    expect(await service.saveLesson(reader, { course: COURSE, lesson: LESSON, seen: 2, title: "Una", description: null })).toEqual({
      kind: "changed",
    });
  });

  it("si la base no contestó, unknown y se reporta", async () => {
    const service = setup();
    vi.mocked(service.store.deleteLesson).mockRejectedValueOnce(new Error("caída"));
    expect(await service.deleteLesson(reader, { course: COURSE, lesson: LESSON, seen: 1 })).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["draft_change_unavailable"]);
  });
});

describe("leer el borrador", () => {
  it("las opciones del editor llevan lo elegido; un id sin forma cuenta como nada elegido", async () => {
    const service = setup();
    expect(await service.draftChoices({ practiceId: PRACTICE, levelId: "x" })).toEqual({ kind: "ready", value: { practices: [], levels: [] } });
    expect(service.store.choices).toHaveBeenCalledExactlyOnceWith(PRACTICE, null);
  });

  it("si no se pudieron leer las opciones, «no se supo», reportado", async () => {
    const service = setup();
    vi.mocked(service.store.choices).mockRejectedValueOnce(new Error("se cayó"));
    expect(await service.draftChoices({ practiceId: null, levelId: null })).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["draft_read_unavailable"]);
  });

  it("lee los cursos como la persona", async () => {
    const service = setup();
    expect(await service.teacherCourses(claims)).toEqual({ kind: "ready", value: [] });
    expect(service.store.teacherCourses).toHaveBeenCalledExactlyOnceWith(claims);
  });

  it("un id sin forma no existe, sin preguntarle a la base", async () => {
    const service = setup();
    expect(await service.draftCourse(claims, "../otro")).toEqual({ kind: "ready", value: null });
    expect(service.store.draftCourse).not.toHaveBeenCalled();
  });

  it("si la lectura falla, unavailable y se reporta", async () => {
    const service = setup();
    vi.mocked(service.store.draftCourse).mockRejectedValueOnce(new Error("caída"));
    expect(await service.draftCourse(claims, COURSE)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["draft_read_unavailable"]);
  });
});
