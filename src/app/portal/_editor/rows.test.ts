import { describe, expect, it } from "vitest";

import type { DraftChoices, DraftCourse } from "@/services/drafts/editor";

import { editorView } from "./rows";

// Lo que el editor de curso pinta (PA-43; T-402), ya en palabras y con los valores de sus botones.

const COURSE = "c0000000-0000-4000-8000-000000000001";
const M1 = "d0000000-0000-4000-8000-000000000001";
const M2 = "d0000000-0000-4000-8000-000000000002";
const L1 = "e0000000-0000-4000-8000-000000000001";
const L2 = "e0000000-0000-4000-8000-000000000002";
const L3 = "e0000000-0000-4000-8000-000000000003";
const P1 = "f0000000-0000-4000-8000-000000000001";
const P2 = "f0000000-0000-4000-8000-000000000002";
const LV = "f0000000-0000-4000-8000-000000000003";

const draft: DraftCourse = {
  id: COURSE,
  state: "draft",
  version: 1,
  title: "Respirar",
  summary: null,
  practiceId: P1,
  levelId: LV,
  revision: 4,
  structureRevision: 3,
  contentRevision: 9,
  updatedAt: "2026-10-29T18:05:00.000Z",
  teacherName: "Ana Ruiz",
  resources: [],
  videos: [],
  modules: [
    {
      id: M1,
      title: "Inicio",
      position: 1,
      revision: 5,
      lessons: [
        { id: L1, title: "Una", description: null, position: 1, revision: 1 },
        { id: L2, title: "Dos", description: "Qué se hace.", position: 2, revision: 2 },
      ],
    },
    { id: M2, title: "Cierre", position: 2, revision: 1, lessons: [{ id: L3, title: "Tres", description: null, position: 1, revision: 1 }] },
  ],
};
const choices: DraftChoices = {
  practices: [
    { id: P1, name: "Respiración", tone: 3, active: false },
    { id: P2, name: "Yoga", tone: 5, active: true },
  ],
  levels: [{ id: LV, name: "Inicial", active: true }],
  resourceLimits: { maxBytes: 52428800, perPlace: 10 },
  videoMaxBytes: 5368709120,
};
const NOW = new Date("2026-10-29T20:00:00.000Z");
const view = (search: Record<string, string> = {}, readOnly = false, changes: Partial<DraftCourse> = {}) =>
  editorView({ ...draft, ...changes }, choices, { readOnly, search, now: NOW });

describe("editorView", () => {
  it("la barra: título, estado y la hora del guardado en la zona del producto", () => {
    expect(view()).toMatchObject({ course: COURSE, title: "Respirar", state: "Borrador", saved: "Guardado a las 12:05 p.m.", editable: true });
    expect(view({}, false, { updatedAt: "2026-10-20T18:05:00.000Z" }).saved).toBe("Guardado el 20 de octubre de 2026 a las 12:05 p.m.");
  });

  it("los datos: la práctica desactivada sigue elegida y marcada, y se avisa", () => {
    const { data } = view();
    expect(data).toMatchObject({ practice: P1, level: LV, inactive: true, save: "save-course:4" });
    expect(data.practices).toEqual([
      { value: P1, label: "Respiración (desactivada)" },
      { value: P2, label: "Yoga" },
    ]);
    expect(data.cover).toEqual({ title: "Respirar", teacherName: "Ana Ruiz", practiceName: "Respiración", tone: 3 });
  });

  it("la estructura: la primera no sube, la última no baja, y «Mover a» ofrece los otros módulos al final", () => {
    const { structure } = view();
    expect(structure.addModule).toBe("add-module:3");
    const [first, second] = structure.modules;
    expect(first).toMatchObject({ label: "Módulo 1", up: null, down: `module-down:${M1}:1`, addLesson: `add-lesson:${M1}:5` });
    expect(second).toMatchObject({ up: `module-up:${M2}:2`, down: null });
    expect(first?.lessons[0]).toMatchObject({ up: null, down: `lesson-down:${L1}:${M1}:1`, move: `lesson-move:${L1}:${M1}:1` });
    expect(first?.lessons[0]?.targets).toEqual([{ value: `${M2}:2`, label: "Cierre" }]);
    expect(first?.lessons[1]).toMatchObject({ up: `lesson-up:${L2}:${M1}:2`, down: null });
    expect(first?.lessons.map((lesson) => lesson.number)).toEqual(["1.1", "1.2"]);
    expect(second?.lessons[0]?.number).toBe("2.1");
    expect(first?.lessons[0]?.href).toBe(`/portal/cursos/${COURSE}?leccion=${L1}`);
  });

  it("lo elegido sale de la dirección, solo si es de este curso", () => {
    expect(view({ leccion: L2 }).selected).toEqual({
      kind: "lesson",
      id: L2,
      title: "Dos",
      place: "Módulo 1 · Lección 2",
      description: "Qué se hace.",
      save: `save-lesson:${L2}:2`,
      askDelete: `ask-delete-lesson:${L2}`,
      remove: `delete-lesson:${L2}:2`,
      resources: [],
      video: null,
    });
    expect(view({ modulo: M1 }).selected).toMatchObject({ kind: "module", id: M1, place: "Módulo 1", lessons: 2, save: `save-module:${M1}:5`, remove: `delete-module:${M1}:5` });
    expect(view({ leccion: L3 }).selected).toMatchObject({ kind: "lesson", place: "Módulo 2 · Lección 1" });
    expect(view({ modulo: M2 }).selected).toMatchObject({ kind: "module", place: "Módulo 2" });
    expect(view({ leccion: "e0000000-0000-4000-8000-0000000000ff" }).selected).toEqual({ kind: "course" });
    expect(view({ modulo: L1 }).selected).toEqual({ kind: "course" });
    expect(view({ leccion: L1 }).paths.self).toBe(`/portal/cursos/${COURSE}?leccion=${L1}`);
    expect(view().paths.self).toBe(`/portal/cursos/${COURSE}`);
  });

  it("los recursos: cada lugar su lista, en orden, con lo que son y su tamaño en palabras", () => {
    const resource = (id: string, lessonId: string | null, position: number, kind: "pdf" | "doc" | "audio", sizeBytes: number) => ({
      id,
      lessonId,
      title: id,
      kind,
      sizeBytes,
      position,
      revision: 3,
    });
    const resources = [
      resource("b", L1, 2, "audio", 512 * 1024),
      resource("a", L1, 1, "pdf", 2 * 1024 * 1024),
      resource("c", null, 1, "doc", 1536 * 1024),
      resource("d", null, 2, "pdf", 10),
    ];
    const lesson = view({ leccion: L1 }, false, { resources }).selected;
    if (lesson.kind !== "lesson") throw new Error("Debía ser la lección.");
    expect(lesson.resources.map((row) => [row.id, row.detail])).toEqual([
      ["a", "PDF, 2 MB"],
      ["b", "Audio, 512 KB"],
    ]);
    expect(lesson.resources[0]).toMatchObject({ up: null, down: "resource-move:a:1:2", revision: 3 });
    expect(lesson.resources[1]).toMatchObject({ up: "resource-move:b:2:1", down: null });
    const { data, resourceLimits } = view({}, false, { resources });
    expect(data.resources.map((row) => [row.id, row.detail])).toEqual([
      ["c", "Word, 1.5 MB"],
      ["d", "PDF, 1 KB"],
    ]);
    expect(resourceLimits).toEqual({ maxBytes: 52428800, maxText: "50 MB", perPlace: 10 });
  });

  it("en solo lectura no se ofrece nada que cambie", () => {
    expect(view({}, true).editable).toBe(false);
    expect(view({}, false, { state: "in_review" })).toMatchObject({ editable: false, notice: "No se puede editar mientras está en revisión." });
  });
});
