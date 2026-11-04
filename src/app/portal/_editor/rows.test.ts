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
  pendingVersion: null,
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
  returned: null,
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
  lessonTolerance: { minSeconds: 900, maxSeconds: 1500 },
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

  it("un borrador nuevo no se descarta: se borra desde Mis cursos", () => {
    expect(view().discardHref).toBeNull();
  });
});

describe("la versión de un curso publicado (T-405, FL-36)", () => {
  const version: Partial<DraftCourse> = { state: "changes_pending", pendingVersion: "draft", version: 2 };

  it("en borrador se edita y se envía, con el aviso de que los alumnos siguen viendo lo publicado, y se descarta", () => {
    expect(view({}, false, version)).toMatchObject({
      editable: true,
      state: "Con cambios pendientes",
      tone: "active",
      notice: "Tus alumnos siguen viendo la versión publicada hasta que se apruebe la nueva.",
      submitHref: `/portal/cursos/${COURSE}/enviar`,
      discardHref: `/portal/cursos/${COURSE}/descartar`,
    });
  });

  it("enviada, en solo lectura y sin descartar", () => {
    expect(view({}, false, { ...version, pendingVersion: "in_review" })).toMatchObject({
      editable: false,
      state: "En revisión",
      notice: "No se puede editar mientras está en revisión.",
      submitHref: null,
      discardHref: null,
    });
  });

  it("al suspendido, ni editar ni descartar", () => {
    expect(view({}, true, version)).toMatchObject({ editable: false, submitHref: null, discardHref: null });
  });
});

describe("cada cuánto preguntar por los videos", () => {
  const video = (state: DraftCourse["videos"][number]["state"], captionsReady = false): DraftCourse["videos"][number] => ({
    id: "f0000000-0000-4000-8000-000000000001",
    lessonId: "e0000000-0000-4000-8000-000000000001",
    state,
    isCurrent: state === "ready",
    fileName: "clase.mp4",
    sizeBytes: 1000,
    captionsReady,
    seconds: null,
    errorCode: null,
    claimedAt: null,
    deletesAt: null,
  });

  it.each([
    [[], null],
    [[video("uploading")], null],
    [[video("errored")], null],
    [[video("ready", true)], null],
    [[video("ready")], 60],
    [[video("uploaded")], 60],
    [[video("creating")], 15],
    [[video("processing")], 15],
    [[video("ready"), video("processing")], 15],
  ])("con %j, cada %s", (videos, every) => {
    expect(view({}, false, { videos }).checkVideosEvery).toBe(every);
  });
});

describe("el video de una lección", () => {
  const LESSON = "e0000000-0000-4000-8000-000000000001";
  const NOW = "2026-11-10T18:00:00.000Z";
  const video = (fields: Partial<DraftCourse["videos"][number]>): DraftCourse["videos"][number] => ({
    id: "f0000000-0000-4000-8000-000000000001",
    lessonId: LESSON,
    state: "uploaded",
    isCurrent: false,
    fileName: "clase.mp4",
    sizeBytes: 1000,
    captionsReady: false,
    seconds: null,
    errorCode: null,
    claimedAt: null,
    deletesAt: null,
    ...fields,
  });
  const ready = (seconds: number, fields: Partial<DraftCourse["videos"][number]> = {}) => video({ id: "f0000000-0000-4000-8000-000000000002", state: "ready", isCurrent: true, fileName: "vigente.mp4", seconds, ...fields });
  const rowOf = (videos: DraftCourse["videos"], tolerance: DraftChoices["lessonTolerance"] = choices.lessonTolerance) => {
    const lessons = [{ id: LESSON, title: "Una", description: null, position: 1, revision: 1 }];
    const course = { ...draft, videos, modules: [{ ...draft.modules[0]!, lessons }] };
    const shown = editorView(course, { ...choices, lessonTolerance: tolerance }, { readOnly: false, search: { leccion: LESSON }, now: new Date(NOW) }).selected;
    if (shown.kind !== "lesson") throw new Error("no es una lección");
    return shown.video;
  };

  it("sin video, nada", () => {
    expect(rowOf([])).toBeNull();
  });

  it("dice el día en que se borra, en la zona del producto", () => {
    // A las 02:00 UTC del 18 todavía es el 17 en la Ciudad de México.
    expect(rowOf([video({ deletesAt: "2026-11-18T02:00:00.000Z" })])?.deletesOn).toBe("17 de noviembre de 2026");
    expect(rowOf([ready(1200)])?.deletesOn).toBeNull();
  });

  it("está tardando pasada una hora de procesarse: dice cuánto falta, y nunca menos de cero", () => {
    expect(rowOf([video({ state: "processing", claimedAt: "2026-11-10T16:59:00.000Z" })])?.slowInMs).toBe(0);
    expect(rowOf([video({ state: "processing", claimedAt: "2026-11-10T17:01:00.000Z" })])?.slowInMs).toBe(60_000);
  });

  it("creándose no: cada reintento renueva el reclamo, y el aviso aparecería y se iría", () => {
    expect(rowOf([video({ state: "creating", claimedAt: "2026-11-10T16:59:00.000Z" })])?.slowInMs).toBeNull();
    expect(rowOf([video({ state: "uploaded", claimedAt: "2026-11-10T16:59:00.000Z" })])?.slowInMs).toBeNull();
    expect(rowOf([ready(1200, { claimedAt: "2026-11-10T10:00:00.000Z" })])?.slowInMs).toBeNull();
  });

  it.each<[string, number, string]>([
    ["una hora o más", 4_920, "1 h 22 min"],
    ["minutos", 1_234, "20 min 34 s"],
    ["menos de un minuto", 45, "45 s"],
  ])("la duración: %s", (_name, seconds, text) => {
    expect(rowOf([ready(seconds)])?.duration).toBe(text);
  });

  it.each<[string, number, boolean]>([
    ["justo en el mínimo", 900, false],
    ["justo en el máximo", 1500, false],
    ["un segundo menos", 899, true],
    ["un segundo más", 1501, true],
  ])("el aviso de duración: %s", (_name, seconds, warns) => {
    const tolerance = rowOf([ready(seconds)])?.tolerance ?? null;
    expect(tolerance !== null).toBe(warns);
    if (warns) expect(tolerance).toMatch(/Lo acordado es de 15 a 25 minutos\. Puedes enviarla: la revisión decide\./);
  });

  it("sin el parámetro no se avisa: no se sabe qué se acordó", () => {
    expect(rowOf([ready(60)], null)?.tolerance).toBeNull();
  });

  it("al reemplazar se ve lo que viene, y la lección sigue con la vigente", () => {
    const row = rowOf([ready(1200), video({ state: "processing", fileName: "nuevo.mp4" })]);
    expect(row).toMatchObject({ fileName: "nuevo.mp4", state: "processing", currentId: "f0000000-0000-4000-8000-000000000002", replacing: { fileName: "vigente.mp4", duration: "20 min 0 s" } });
    expect(rowOf([ready(1200)])).toMatchObject({ replacing: null, currentId: "f0000000-0000-4000-8000-000000000002" });
    expect(rowOf([video({})])).toMatchObject({ replacing: null, currentId: null });
  });

  it("el aviso de duración es de la vigente, aunque otro la vaya a reemplazar", () => {
    expect(rowOf([ready(60), video({ state: "processing" })])?.tolerance).toMatch(/Esta lección dura 1 min 0 s/);
  });

  it("de un error solo se distingue lo que le sirve a quien lo subió", () => {
    expect(rowOf([video({ state: "errored", errorCode: "too_long" })])?.tooLong).toBe(true);
    expect(rowOf([video({ state: "errored", errorCode: "invalid_input" })])?.tooLong).toBe(false);
  });
});
