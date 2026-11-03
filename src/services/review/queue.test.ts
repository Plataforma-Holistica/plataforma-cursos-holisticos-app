import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";
import type { ProviderAsset, VideoProvider, VideoProviders } from "@/services/media/video-provider";

import { APPROVE_ANSWERS, SUBMISSION_APPROVE_ANSWERS, createReviewQueue, type ApproveAssets, type ReviewQueue, type ReviewStore } from "./queue";

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

const SUBMISSION = "f0000000-0000-4000-8000-000000000001";
const V1 = "d1000000-0000-4000-8000-000000000001";
const V2 = "d2000000-0000-4000-8000-000000000002";
const L1 = "e1000000-0000-4000-8000-000000000001";
const L2 = "e2000000-0000-4000-8000-000000000002";
const ASSETS: ApproveAssets = {
  kind: "ok",
  assets: [
    { video: V1, lesson: L1, provider: "mux", asset: "A1", playback: "P1" },
    { video: V2, lesson: L2, provider: "mux", asset: "A2", playback: "P2" },
  ],
};
const READY = (playback: string, captions = true): ProviderAsset => ({ state: "ready", playback, seconds: 300, captions, error: null });

function queueWith(
  setup: {
    check?: TeamCheck;
    queue?: ReviewQueue | null | "throws";
    answer?: string | "throws";
    assets?: ApproveAssets | "throws";
    reads?: Record<string, ProviderAsset | "gone" | null>;
  } = {},
) {
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
    approveAssets: vi.fn((_claims: VerifiedClaims, input: { course: string; submission: string }) => {
      calls.push(`videos ${input.course}`);
      if (setup.assets === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.assets ?? ASSETS);
    }),
    approveSubmission: vi.fn((_claims: VerifiedClaims, input: { course: string }) => {
      calls.push(`publicar ${input.course}`);
      if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve((setup.answer ?? "approved") as never);
    }),
  };
  const reads = setup.reads ?? { A1: READY("P1"), A2: READY("P2") };
  const mux: VideoProvider = {
    create: vi.fn(),
    read: vi.fn((asset: string) => {
      calls.push(`mux ${asset}`);
      return Promise.resolve(reads[asset] ?? null);
    }),
    findByPassthrough: vi.fn(),
    remove: vi.fn(),
  } as unknown as VideoProvider;
  const providers: VideoProviders = { active: () => "mux", of: (name) => (name === "mux" ? mux : null) };
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
    { teamStanding, store, providers },
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

describe("approveSubmission", () => {
  const INPUT = { course: COURSE, submission: SUBMISSION };

  it("la guarda, la forma, los videos del envío, su proveedor y después la base, con los que ya tienen subtítulos", async () => {
    const service = queueWith({ reads: { A1: READY("P1"), A2: READY("P2", false) } });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "answered", answer: "approved" });
    expect(service.calls).toEqual(["guarda", `videos ${COURSE}`, "mux A1", "mux A2", `publicar ${COURSE}`]);
    expect(service.store.approveAssets).toHaveBeenCalledWith(claims, { course: COURSE, submission: SUBMISSION });
    expect(service.store.approveSubmission).toHaveBeenCalledWith(claims, { course: COURSE, submission: SUBMISSION, captions: [V1] });
  });

  it("sin Contenido: refused, sin preguntarle nada a nadie", async () => {
    const service = queueWith({ check: teamCheck(standingOf(["finance"])) });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("no se supo quién pide: unavailable", async () => {
    const service = queueWith({ check: { kind: "unavailable" } as TeamCheck });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each([
    ["el curso", { ...INPUT, course: "x" }],
    ["el envío", { ...INPUT, submission: undefined }],
  ])("%s sin forma no llega a la base", async (_what, input) => {
    const service = queueWith();
    expect(await service.approveSubmission(reader, input)).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each(["forbidden", "needs_fresh_code", "not_found", "not_pending", "changed", "self"] as const)("la base no da los videos (%s): se dice, sin preguntarle a Mux", async (kind) => {
    const service = queueWith({ assets: { kind } });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "answered", answer: kind });
    expect(service.calls).toEqual(["guarda", `videos ${COURSE}`]);
  });

  it("si no se pudieron leer los videos: unavailable, y se reporta", async () => {
    const service = queueWith({ assets: "throws" });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["approve_read_unavailable"]);
  });

  it("si Mux no contesta por uno: no se aprueba a ciegas, y se reporta", async () => {
    const service = queueWith({ reads: { A1: READY("P1"), A2: null } });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["approve_provider_unavailable"]);
    expect(service.calls).not.toContain(`publicar ${COURSE}`);
  });

  it("un video que Mux ya no tiene, o con otra reproducción: dice qué lecciones, y se reporta", async () => {
    const service = queueWith({ reads: { A1: "gone", A2: READY("Otra") } });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "video_not_ready", lessons: [L1, L2] });
    expect(service.reported).toEqual(["approve_video_gone"]);
    expect(service.calls).not.toContain(`publicar ${COURSE}`);
  });

  it.each(SUBMISSION_APPROVE_ANSWERS.filter((answer) => answer !== "unavailable"))("la base contesta %s: tal cual", async (answer) => {
    const service = queueWith({ answer });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "answered", answer });
    expect(service.reported).toEqual([]);
  });

  it("la base contesta unavailable: se dice, y se reporta, porque nadie de la pantalla lo arregla", async () => {
    const service = queueWith({ answer: "unavailable" });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "answered", answer: "unavailable" });
    expect(service.reported).toEqual(["approve_unavailable"]);
  });

  it("si aprobar no contestó: unknown, y se reporta", async () => {
    const service = queueWith({ answer: "throws" });
    expect(await service.approveSubmission(reader, INPUT)).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["course_approval_unavailable"]);
  });
});
