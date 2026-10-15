import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { asServer, ServerActor, Tx } from "@/adapters/supabase/db";
import { toDatabaseError } from "@/adapters/supabase/errors";
import type { SqlQuery } from "@/adapters/supabase/sql";

import { APPROVE_ANSWERS } from "./queue";
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

const LESSON_RAW = { lesson_id: LESSON, module: "Uno", title: "El bosque", duration_seconds: 356, video: "playable" };
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
          teacherName: "Maestra",
          teacherListed: false,
          practice: "Naturaleza",
          level: null,
          lessonCount: 1,
          totalDurationSeconds: 356,
          loadedAt: "2026-10-14T20:00:00+00:00",
          lessons: [{ lessonId: LESSON, module: "Uno", title: "El bosque", durationSeconds: 356, video: "playable" }],
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
