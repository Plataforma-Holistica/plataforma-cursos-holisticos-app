import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { asServer, ServerActor, Tx } from "@/adapters/supabase/db";
import { toDatabaseError } from "@/adapters/supabase/errors";
import type { SqlQuery } from "@/adapters/supabase/sql";

import { APPROVE_ANSWERS, SUBMISSION_APPROVE_ANSWERS } from "./queue";
import { queueOf } from "./records";
import { createReviewStore } from "./store";

// Las consultas de la revisión y lo que el almacén hace alrededor: a nombre de quién abre cada
// transacción, qué reintenta y dónde entiende lo que contestó la base. Contra la base de
// verdad corren en `tests/integration/39-revision.test.ts`.

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const COURSE = "c0000000-0000-4000-8000-000000000002";
const LESSON = "d0000000-0000-4000-8000-000000000003";

function runnerWith(rows: unknown[], failures: unknown[] = []) {
  const opened: ServerActor[] = [];
  const sent: { text: string; values: readonly unknown[] }[] = [];
  const pending = [...failures];
  const tx: Tx = {
    query<Row>(query: SqlQuery, row: ZodType<Row>): Promise<Row[]> {
      sent.push({ text: query.text.replace(/\s+/g, " ").trim(), values: query.values });
      return Promise.resolve(rows.map((each) => row.parse(each)));
    },
    execute: () => Promise.reject(new Error("Estas consultas no ejecutan sentencias.")),
  };
  const run = (async (actor: ServerActor, fn: (tx: Tx) => Promise<unknown>) => {
    opened.push(actor);
    if (pending.length > 0) throw pending.shift();
    return fn(tx);
  }) as typeof asServer;
  return { run, opened, sent };
}

const lockConflict = (code: string) => toDatabaseError({ code, severity: "ERROR" });

const MODULE = "e0000000-0000-4000-8000-000000000004";
const LESSON_RAW = { lesson_id: LESSON, module_id: MODULE, module: "Uno", title: "El bosque", duration_seconds: 356, video: "playable" };
const COURSE_RAW = {
  course_id: COURSE,
  title: "Naturaleza",
  teacher_name: "Maestra",
  teacher_listed: false,
  practice: "Naturaleza",
  level: null,
  lesson_count: 1,
  total_duration_seconds: 356,
  loaded_at: "2026-10-14T20:00:00+00:00",
  lessons: [LESSON_RAW],
};
const RAW = { fresh_code: false, courses: [COURSE_RAW] };

describe("la cola, como la contesta la base", () => {
  it("se lee en nombres de la aplicación", () => {
    expect(queueOf(RAW)).toEqual({
      freshCode: false,
      courses: [
        {
          courseId: COURSE,
          title: "Naturaleza",
          summary: null,
          teacherName: "Maestra",
          teacherListed: false,
          practice: "Naturaleza",
          level: null,
          lessonCount: 1,
          totalDurationSeconds: 356,
          loadedAt: "2026-10-14T20:00:00+00:00",
          lessons: [{ lessonId: LESSON, moduleId: MODULE, module: "Uno", title: "El bosque", durationSeconds: 356, video: "playable", description: null, resources: [] }],
          submission: null,
        },
      ],
    });
  });

  it("nula, cuando quien actúa no pasa la puerta con Contenido", () => {
    expect(queueOf(null)).toBeNull();
  });

  it.each([
    ["un playback id en la lección", { ...RAW, courses: [{ ...COURSE_RAW, lessons: [{ ...LESSON_RAW, playback_id: "x" }] }] }],
    ["un campo de más en el curso", { ...RAW, courses: [{ ...COURSE_RAW, teacher_id: COURSE }] }],
    ["un campo de más en la cola", { ...RAW, playback_ids: [] }],
    ["un estado de video que no conoce", { ...RAW, courses: [{ ...COURSE_RAW, lessons: [{ ...LESSON_RAW, video: "ready" }] }] }],
    ["un curso sin forma de id", { ...RAW, courses: [{ ...COURSE_RAW, course_id: "x" }] }],
  ])("con %s, lanza: no llega a la pantalla", (_what, raw) => {
    expect(() => queueOf(raw)).toThrow();
  });
});

describe("el almacén", () => {
  it("la cola se lee como servidor, con su razón, y sin reintentar", async () => {
    const { run, opened } = runnerWith([{ queue: RAW }], [lockConflict("40P01")]);
    await expect(createReviewStore(run).queue(claims)).rejects.toMatchObject({ code: "40P01" });
    expect(opened).toEqual([{ claims, reason: "review_queue" }]);
  });

  it("aprobar va como servidor, manda el curso como parámetro y no dice de quién es la cuenta", async () => {
    const { run, opened, sent } = runnerWith([{ answer: "approved" }]);
    expect(await createReviewStore(run).approve(claims, COURSE)).toBe("approved");
    expect(opened).toEqual([{ claims, reason: "course_approval" }]);
    expect(sent).toEqual([{ text: "select private.approve_course($1::uuid) as answer", values: [COURSE] }]);
  });

  it.each(["40P01", "55P03"])("un choque de candados (%s) al aprobar se intenta una vez más, y solo una", async (code) => {
    const once = runnerWith([{ answer: "approved" }], [lockConflict(code)]);
    expect(await createReviewStore(once.run).approve(claims, COURSE)).toBe("approved");
    expect(once.opened).toHaveLength(2);
    const twice = runnerWith([{ answer: "approved" }], [lockConflict(code), lockConflict(code)]);
    await expect(createReviewStore(twice.run).approve(claims, COURSE)).rejects.toMatchObject({ code });
    expect(twice.opened).toHaveLength(2);
  });

  it.each(APPROVE_ANSWERS)("%s se entiende", async (answer) => {
    const { run } = runnerWith([{ answer }]);
    expect(await createReviewStore(run).approve(claims, COURSE)).toBe(answer);
  });

  it("una respuesta que no está en su lista lanza: no se pinta como hecha", async () => {
    const { run } = runnerWith([{ answer: "publicado" }]);
    await expect(createReviewStore(run).approve(claims, COURSE)).rejects.toThrow();
  });
});

describe("lo enviado por el portal, en la cola", () => {
  const SUBMISSION = "f0000000-0000-4000-8000-000000000001";
  const lesson = { lesson_id: LESSON, module_id: LESSON, module: "Uno", title: "Primera", duration_seconds: 600, video: "playable" };
  const sent = {
    course_id: COURSE,
    title: "Respirar",
    summary: "Un resumen.",
    teacher_name: "Ana",
    teacher_listed: false,
    practice: "P",
    level: "N",
    lesson_count: 1,
    total_duration_seconds: 600,
    loaded_at: "2026-11-02T18:00:00Z",
    lessons: [{ ...lesson, description: null, resources: [{ id: LESSON, title: "Guía", kind: "pdf", size_bytes: 100 }] }],
    submission: { id: SUBMISSION, number: 1, resources: [], captions_missing: [LESSON], files_changed: ["Guía"], annex: { version: 1, accepted_at: "2026-11-02T18:00:00Z", statement: "Acepto.", term_years: 10 } },
  };

  it("se lee con su envío y sus recursos", () => {
    const [course] = queueOf({ fresh_code: true, courses: [sent] })?.courses ?? [];
    expect(course?.summary).toBe("Un resumen.");
    expect(course?.lessons[0]?.resources).toEqual([{ id: LESSON, title: "Guía", kind: "pdf", sizeBytes: 100 }]);
    expect(course?.submission).toEqual({
      id: SUBMISSION,
      number: 1,
      resources: [],
      captionsMissing: [LESSON],
      filesChanged: ["Guía"],
      annex: { version: 1, acceptedAt: "2026-11-02T18:00:00Z", statement: "Acepto.", termYears: 10 },
    });
  });

  it("uno por guion, sin esos campos, sale sin envío", () => {
    const script = Object.fromEntries(Object.entries(sent).filter(([key]) => key !== "summary" && key !== "submission"));
    const [course] = queueOf({ fresh_code: true, courses: [{ ...script, lessons: [lesson] }] })?.courses ?? [];
    expect(course).toMatchObject({ summary: null, submission: null });
    expect(course?.lessons[0]).toMatchObject({ description: null, resources: [] });
  });

  it.each([
    ["una ruta en un recurso", { ...sent, lessons: [{ ...lesson, resources: [{ id: LESSON, title: "Guía", kind: "pdf", size_bytes: 100, storage_path: "ruta" }] }] }],
    ["el origen en el anexo", { ...sent, submission: { ...sent.submission, annex: { ...sent.submission.annex, ip: "203.0.113.7" } } }],
    ["la huella en el envío", { ...sent, submission: { ...sent.submission, content_sha256: "ab" } }],
  ])("%s no pasa: la lectura es estricta", (_what, course) => {
    expect(() => queueOf({ fresh_code: true, courses: [course] })).toThrow();
  });
});

describe("devolver", () => {
  const INPUT = { course: COURSE, submission: LESSON, reason: "Motivo.", whatToFix: "Corrección." };

  it("va a nombre de las claims, con el envío que se vio", async () => {
    const { run, opened, sent } = runnerWith([{ answer: "returned" }]);
    expect(await createReviewStore(run).returnCourse(claims, INPUT)).toBe("returned");
    expect(opened.map((actor) => actor.reason)).toEqual(["course_return"]);
    expect(sent[0]?.text).toContain("private.review_return(");
    expect(sent[0]?.values).toEqual([COURSE, LESSON, "Motivo.", "Corrección."]);
  });

  it("una respuesta que no conoce lanza: no se pinta como hecha", async () => {
    const { run } = runnerWith([{ answer: "otra" }]);
    await expect(createReviewStore(run).returnCourse(claims, INPUT)).rejects.toThrow();
  });
});

describe("aprobar lo enviado", () => {
  const SUBMISSION = "f0000000-0000-4000-8000-000000000001";
  const VIDEO = "a1000000-0000-4000-8000-000000000005";
  const INPUT = { course: COURSE, submission: SUBMISSION, captions: [VIDEO] };

  it("los videos se leen a nombre de las claims, en nombres de la aplicación", async () => {
    const { run, opened, sent } = runnerWith([{ assets: { answer: "ok", assets: [{ video: VIDEO, lesson: LESSON, provider: "mux", asset: "A", playback: "P" }] } }]);
    expect(await createReviewStore(run).approveAssets(claims, { course: COURSE, submission: SUBMISSION })).toEqual({
      kind: "ok",
      assets: [{ video: VIDEO, lesson: LESSON, provider: "mux", asset: "A", playback: "P" }],
    });
    expect(opened.map((actor) => actor.reason)).toEqual(["course_approval"]);
    expect(sent[0]?.text).toContain("private.review_approve_assets(");
    expect(sent[0]?.values).toEqual([COURSE, SUBMISSION]);
  });

  it.each(["forbidden", "needs_fresh_code", "not_found", "not_pending", "changed", "self"])("los videos, con %s, lo dicen", async (answer) => {
    const { run } = runnerWith([{ assets: { answer } }]);
    expect(await createReviewStore(run).approveAssets(claims, { course: COURSE, submission: SUBMISSION })).toEqual({ kind: answer });
  });

  it("unos videos con otra forma lanzan: la lectura es estricta", async () => {
    const { run } = runnerWith([{ assets: { answer: "ok", assets: [{ video: VIDEO, lesson: LESSON, provider: "mux", asset: "A", playback: "P", path: "ruta" }] } }]);
    await expect(createReviewStore(run).approveAssets(claims, { course: COURSE, submission: SUBMISSION })).rejects.toThrow();
  });

  it("aprobar va con el envío que se vio y los videos con subtítulos", async () => {
    const { run, sent } = runnerWith([{ answer: "approved" }]);
    expect(await createReviewStore(run).approveSubmission(claims, INPUT)).toBe("approved");
    expect(sent[0]?.text).toContain("private.review_approve(");
    expect(sent[0]?.values).toEqual([COURSE, SUBMISSION, [VIDEO]]);
  });

  it.each(SUBMISSION_APPROVE_ANSWERS)("contesta %s tal cual", async (answer) => {
    const { run } = runnerWith([{ answer }]);
    expect(await createReviewStore(run).approveSubmission(claims, INPUT)).toBe(answer);
  });

  it("un choque de candados se intenta una vez más", async () => {
    const { run, opened } = runnerWith([{ answer: "approved" }], [lockConflict("55P03")]);
    expect(await createReviewStore(run).approveSubmission(claims, INPUT)).toBe("approved");
    expect(opened).toHaveLength(2);
  });

  it("una respuesta que no conoce lanza: no se pinta como hecha", async () => {
    const { run } = runnerWith([{ answer: "incomplete" }]);
    await expect(createReviewStore(run).approveSubmission(claims, INPUT)).rejects.toThrow();
  });
});
