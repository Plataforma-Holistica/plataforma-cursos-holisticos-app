import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { createLessons, OPEN_MEMORY_MS } from "./lessons";
import type { LessonRowData } from "./page";

vi.mock("server-only", () => ({}));
vi.mock("@/adapters/supabase/db", () => ({ asSystem: vi.fn(), asUser: vi.fn() }));
vi.mock("@/services/error-reporting/server", () => ({ reportFailure: vi.fn() }));

// El servicio de la página de una lección, con su almacén simulado: qué se le pregunta y qué se
// contesta. Contra la base de verdad, en tests/integration/40-leccion.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const LESSON = "b0000000-0000-4000-8000-000000000002";
const ROW: LessonRowData = {
  courseSlug: "respirar",
  courseTitle: "Respirar",
  courseSummary: null,
  teacherName: "Ana",
  moduleId: "m1",
  moduleTitle: "Uno",
  modulePosition: 1,
  lessonId: LESSON,
  lessonTitle: "Primera",
  lessonPosition: 1,
  durationSeconds: 60,
};

function lessonsWith(store: { rows?: LessonRowData[] | "throws"; open?: boolean | null | "throws" } = {}) {
  const reported: string[] = [];
  const storeLessons = vi.fn(() => (store.rows === "throws" ? Promise.reject(new Error("sin base")) : Promise.resolve(store.rows ?? [ROW])));
  const open = "open" in store ? store.open : false;
  const storeOpen = vi.fn(() => (open === "throws" ? Promise.reject(new Error("sin base")) : Promise.resolve(open ?? null)));
  const service = createLessons({ store: { courseLessons: storeLessons, courseIsOpen: storeOpen }, report: (code) => (reported.push(code), Promise.resolve()) });
  return { ...service, reported, storeLessons, storeOpen };
}

describe("la página de una lección", () => {
  it("la encuentra, con las claims de quien la pide", async () => {
    const service = lessonsWith();
    expect(await service.lessonPage(claims, "respirar", LESSON)).toMatchObject({ kind: "found", page: { lesson: { id: LESSON } } });
    expect(service.storeLessons).toHaveBeenCalledExactlyOnceWith(claims, "respirar");
  });

  it.each([
    ["un slug sin forma", "Respirar/../x", LESSON],
    ["un id sin forma", "respirar", "no-es-un-id"],
    ["un id en mayúsculas", "respirar", LESSON.toUpperCase()],
  ])("%s: not_found, sin preguntarle a la base", async (_what, slug, id) => {
    const service = lessonsWith();
    expect(await service.lessonPage(claims, slug, id)).toEqual({ kind: "not_found" });
    expect(service.storeLessons).not.toHaveBeenCalled();
  });

  it("una lección que no está en ese curso: not_found", async () => {
    expect(await lessonsWith({ rows: [] }).lessonPage(claims, "respirar", LESSON)).toEqual({ kind: "not_found" });
  });

  it("si la base no contesta: unavailable, y se reporta", async () => {
    const service = lessonsWith({ rows: "throws" });
    expect(await service.lessonPage(claims, "respirar", LESSON)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["lesson_page_unavailable"]);
  });
});

describe("si el curso es el abierto, para quien llega sin sesión", () => {
  it.each([
    [true, true],
    [false, false],
    [null, null],
    ["throws", null],
  ] as const)("la base dice %s: %s, sin reportar", async (open, expected) => {
    const service = lessonsWith({ open });
    expect(await service.courseIsOpen("respirar")).toBe(expected);
    expect(service.reported).toEqual([]);
  });

  it("lo recuerda treinta segundos por curso, también si no se supo; pasado eso, pregunta otra vez", async () => {
    let clock = 1_000;
    const storeOpen = vi.fn(() => Promise.resolve(true));
    const service = createLessons({ store: { courseLessons: vi.fn(), courseIsOpen: storeOpen }, report: () => Promise.resolve(), now: () => clock });
    expect(await service.courseIsOpen("respirar")).toBe(true);
    clock += OPEN_MEMORY_MS - 1;
    expect(await service.courseIsOpen("respirar")).toBe(true);
    expect(storeOpen).toHaveBeenCalledOnce();
    // Otro curso es otra pregunta.
    await service.courseIsOpen("dormir");
    expect(storeOpen).toHaveBeenCalledTimes(2);
    clock += 1;
    await service.courseIsOpen("respirar");
    expect(storeOpen).toHaveBeenCalledTimes(3);

    const failing = vi.fn(() => Promise.reject(new Error("sin base")));
    const unsure = createLessons({ store: { courseLessons: vi.fn(), courseIsOpen: failing }, report: () => Promise.resolve(), now: () => clock });
    expect(await unsure.courseIsOpen("respirar")).toBeNull();
    expect(await unsure.courseIsOpen("respirar")).toBeNull();
    expect(failing).toHaveBeenCalledOnce();
  });

  it("un slug sin forma no llega a la base", async () => {
    const service = lessonsWith({ open: true });
    expect(await service.courseIsOpen("no/es")).toBeNull();
    expect(service.storeOpen).not.toHaveBeenCalled();
  });
});
