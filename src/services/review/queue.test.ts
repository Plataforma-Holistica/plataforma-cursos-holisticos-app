import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";

import { APPROVE_ANSWERS, createReviewQueue, type ReviewQueue, type ReviewStore } from "./queue";

// La cola de revisión y aprobar, con todo lo de fuera simulado: a quién se le pregunta qué, en
// qué orden, y qué se decide con cada respuesta. Contra la base de verdad, en
// `tests/integration/39-revision.test.ts` y `supabase/tests/19_revision.test.sql`.

const ME = "a0000000-0000-4000-8000-000000000001";
const COURSE = "c0000000-0000-4000-8000-000000000002";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const QUEUE: ReviewQueue = { freshCode: true, courses: [] };

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["content"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function queueWith(setup: { check?: TeamCheck; queue?: ReviewQueue | null | "throws"; answer?: string | "throws" } = {}) {
  const calls: string[] = [];
  const reported: string[] = [];
  const store: ReviewStore = {
    returnCourse: vi.fn((_claims: VerifiedClaims, input: { course: string }) => {
      calls.push(`devolver ${input.course}`);
      if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve((setup.answer ?? "returned") as never);
    }),
    queue: vi.fn(() => {
      calls.push("cola");
      if (setup.queue === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.queue === undefined ? QUEUE : setup.queue);
    }),
    approve: vi.fn((_claims: VerifiedClaims, course: string) => {
      calls.push(`aprobar ${course}`);
      if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve((setup.answer ?? "approved") as never);
    }),
  };
  const teamStanding = vi.fn(() => {
    calls.push("guarda");
    return Promise.resolve(setup.check ?? teamCheck());
  });
  const service = createReviewQueue(
    {
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { teamStanding, store },
  );
  return { ...service, calls, reported, store };
}

const reader = { get: () => undefined };

describe("reviewQueue", () => {
  it("lee la cola con las claims que la guarda dio, sin volver a correrla", async () => {
    const service = queueWith();
    expect(await service.reviewQueue(reader, claims)).toEqual({ kind: "queue", queue: QUEUE });
    expect(service.calls).toEqual(["cola"]);
    expect(service.store.queue).toHaveBeenCalledWith(claims);
  });

  it("nula, y la guarda ya no la deja pasar: no se supo, sin reportar", async () => {
    const service = queueWith({ queue: null, check: teamCheck(standingOf(["config"])) });
    expect(await service.reviewQueue(reader, claims)).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["cola", "guarda"]);
    expect(service.reported).toEqual([]);
  });

  it("nula, y la guarda insiste en que pasa: la base y la guarda no coinciden, y se reporta", async () => {
    const service = queueWith({ queue: null });
    expect(await service.reviewQueue(reader, claims)).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["cola", "guarda"]);
    expect(service.reported).toEqual(["review_queue_unavailable"]);
  });

  it("si no se pudo leer: no se supo, y se reporta", async () => {
    const service = queueWith({ queue: "throws" });
    expect(await service.reviewQueue(reader, claims)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["review_queue_unavailable"]);
  });
});

describe("approveCourse", () => {
  it("la guarda primero, la forma después, y entonces la base", async () => {
    const service = queueWith();
    expect(await service.approveCourse(reader, { course: COURSE })).toEqual({ kind: "answered", answer: "approved" });
    expect(service.calls).toEqual(["guarda", `aprobar ${COURSE}`]);
    expect(service.store.approve).toHaveBeenCalledWith(claims, COURSE);
  });

  it.each([
    ["una cuenta común", { kind: "none", claims } as unknown as TeamCheck],
    ["del equipo sin Contenido", teamCheck(standingOf(["config"]))],
    ["una invitada con Contenido", teamCheck({ state: "invited", capabilities: ["content"] } as unknown as TeamStanding)],
  ])("%s: refused, sin preguntarle nada a la base", async (_who, check) => {
    const service = queueWith({ check });
    expect(await service.approveCourse(reader, { course: COURSE })).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("si no se supo quién pide: unavailable, sin preguntar nada más", async () => {
    const service = queueWith({ check: { kind: "unavailable" } as TeamCheck });
    expect(await service.approveCourse(reader, { course: COURSE })).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each([
    ["sin curso", undefined],
    ["un número", 7],
    ["un id sin forma", "no-es-un-id"],
    ["un id en mayúsculas", COURSE.toUpperCase()],
  ])("%s: malformed, sin llegar a la base", async (_what, course) => {
    const service = queueWith();
    expect(await service.approveCourse(reader, { course })).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each(APPROVE_ANSWERS)("la base contesta %s: tal cual", async (answer) => {
    const service = queueWith({ answer });
    expect(await service.approveCourse(reader, { course: COURSE })).toEqual({ kind: "answered", answer });
    expect(service.reported).toEqual([]);
  });

  it("una excepción (o una respuesta fuera de la lista, que el almacén rechaza): unknown, y se reporta", async () => {
    const service = queueWith({ answer: "throws" });
    expect(await service.approveCourse(reader, { course: COURSE })).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["course_approval_unavailable"]);
  });
});

describe("returnCourse", () => {
  const COURSE = "c0000000-0000-4000-8000-000000000002";
  const SUBMISSION = "f0000000-0000-4000-8000-000000000001";
  const INPUT = { course: COURSE, submission: SUBMISSION, reason: "  El audio se corta.\r\nEn la 1.  ", whatToFix: " Súbela otra vez. " };

  it("corre la guarda y le pasa a la base el texto ya revisado", async () => {
    const service = queueWith();
    expect(await service.returnCourse(reader, INPUT)).toEqual({ kind: "answered", answer: "returned" });
    expect(service.calls).toEqual(["guarda", `devolver ${COURSE}`]);
    expect(service.store.returnCourse).toHaveBeenCalledWith(claims, { course: COURSE, submission: SUBMISSION, reason: "El audio se corta.\nEn la 1.", whatToFix: "Súbela otra vez." });
  });

  it("sin Contenido: refused, sin preguntarle nada a la base", async () => {
    const service = queueWith({ check: teamCheck(standingOf(["finance"])) });
    expect(await service.returnCourse(reader, INPUT)).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("no se supo quién pide: unavailable", async () => {
    const service = queueWith({ check: { kind: "unavailable" } as TeamCheck });
    expect(await service.returnCourse(reader, INPUT)).toEqual({ kind: "unavailable" });
  });

  it.each([
    ["el curso", { ...INPUT, course: "x" }],
    ["el envío", { ...INPUT, submission: 7 }],
  ])("%s sin forma no llega a la base", async (_what, input) => {
    const service = queueWith();
    expect(await service.returnCourse(reader, input)).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each([
    ["sin motivo", { ...INPUT, reason: "   " }],
    ["sin qué corregir", { ...INPUT, whatToFix: "\n" }],
    ["un motivo que no es texto", { ...INPUT, reason: 3 }],
    ["un carácter de ancho cero", { ...INPUT, whatToFix: "a\u200b" }],
  ])("%s: invalid, sin preguntarle a la base", async (_what, input) => {
    const service = queueWith();
    expect(await service.returnCourse(reader, input)).toEqual({ kind: "answered", answer: "invalid" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("si la base no contestó: unknown, y se reporta", async () => {
    const service = queueWith({ answer: "throws" });
    expect(await service.returnCourse(reader, INPUT)).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["course_return_unavailable"]);
  });
});
