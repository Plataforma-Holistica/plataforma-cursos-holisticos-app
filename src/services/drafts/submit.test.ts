import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { ProviderAsset, VideoProvider } from "@/services/media/video-provider";

import { createSubmit, type SubmitAnswer, type SubmitAssets, type SubmitStore } from "./submit";

// Enviar un curso desde el portal (T-405): a quién se le pregunta qué y en qué orden. Lo que decide la base lo prueban la 74 y la 76, y la integración 97.

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const COURSE = "c0000000-0000-4000-8000-000000000002";
const ANNEX = "a1000000-0000-4000-8000-000000000003";
const LESSON = "d0000000-0000-4000-8000-000000000004";
const HASH = "a".repeat(64);
const INPUT = { course: COURSE, annex: ANNEX, seen: HASH, term: 10, submission: 1, accepted: true };
const ORIGIN = { realIp: "203.0.113.7", userAgent: "Navegador" };
const READY: ProviderAsset = { state: "ready", playback: "Play", seconds: 600, captions: true, error: null };

function submitWith(
  setup: {
    session?: SessionCheck;
    assets?: SubmitAssets | "throws";
    read?: ProviderAsset | "gone" | null | "throws";
    provider?: "none";
    answer?: SubmitAnswer | "throws";
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const mux: VideoProvider = {
    create: vi.fn(),
    findByPassthrough: vi.fn(),
    remove: vi.fn(),
    read: vi.fn((asset: string) => {
      calls.push(`mux ${asset}`);
      if (setup.read === "throws") return Promise.reject(new Error("sin red"));
      return Promise.resolve(setup.read === undefined ? READY : setup.read);
    }),
  };
  const store: SubmitStore = {
    preview: vi.fn(() => Promise.resolve({ kind: "not_found" as const })),
    assets: vi.fn(() => {
      calls.push("assets");
      if (setup.assets === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve<SubmitAssets>(setup.assets ?? { kind: "ok", assets: [{ lesson: LESSON, provider: "mux", asset: "Asset1" }] });
    }),
    submit: vi.fn(() => {
      calls.push("enviar");
      if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.answer ?? "submitted");
    }),
    accepted: vi.fn(() => Promise.resolve([])),
    annex: vi.fn(() => Promise.resolve(null)),
  };
  const service = createSubmit({
    store,
    providers: { active: () => "mux", of: (name) => (setup.provider === "none" ? null : name === "mux" ? mux : null) },
    checkSession: () => (calls.push("guarda"), Promise.resolve(setup.session ?? { kind: "pass", claims })),
    evidence: (origin) => ({ address: origin.realIp, userAgent: origin.userAgent }),
    report: (code) => (reported.push(code), Promise.resolve()),
  });
  return { service, calls, reported, store, mux };
}

const reader = { get: () => undefined };

describe("submitCourse", () => {
  it("guarda, assets, Mux y después la base, con lo que se vio y el origen", async () => {
    const { service, calls, store } = submitWith();
    expect(await service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "submitted" });
    expect(calls).toEqual(["guarda", "assets", "mux Asset1", "enviar"]);
    expect(store.submit).toHaveBeenCalledWith(claims, { course: COURSE, annex: ANNEX, seen: HASH, term: 10, submission: 1 }, { address: "203.0.113.7", userAgent: "Navegador" });
  });

  it("sin una sesión que pase no se le pregunta nada a nadie", async () => {
    const { service, calls } = submitWith({ session: { kind: "anonymous" } as SessionCheck });
    expect(await service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "session", check: { kind: "anonymous" } });
    expect(calls).toEqual(["guarda"]);
  });

  it("sin la casilla no se llega a la base", async () => {
    for (const accepted of [false, "si", undefined]) {
      const { service, calls } = submitWith();
      expect(await service.submitCourse(reader, { ...INPUT, accepted }, ORIGIN)).toEqual({ kind: "not_accepted" });
      expect(calls).toEqual(["guarda"]);
    }
  });

  it.each([
    ["el curso", { course: "x" }],
    ["el anexo", { annex: 3 }],
    ["la huella", { seen: "ab" }],
    ["el plazo", { term: 0 }],
    ["el envío", { submission: 1.5 }],
  ])("%s sin forma no llega a la base", async (_what, over) => {
    const { service, calls } = submitWith();
    expect(await service.submitCourse(reader, { ...INPUT, ...over }, ORIGIN)).toEqual({ kind: "malformed" });
    expect(calls).toEqual(["guarda"]);
  });

  it.each([
    ["ya no está", "gone"],
    ["se está procesando", { ...READY, state: "preparing" }],
    ["tiene error", { ...READY, state: "errored" }],
    ["no tiene reproducción firmada", { ...READY, playback: null }],
  ] as const)("un video que en Mux %s no se envía", async (_what, read) => {
    const { service, calls } = submitWith({ read });
    expect(await service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "video_not_ready" });
    expect(calls).not.toContain("enviar");
  });

  it("si Mux no contesta, no se envía, y se reporta", async () => {
    const { service, calls, reported } = submitWith({ read: null });
    expect(await service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "unavailable" });
    expect(calls).not.toContain("enviar");
    expect(reported).toEqual(["submit_provider_unavailable"]);
  });

  it("un proveedor con el que esta instalación no habla, o un video sin asset, tampoco se firma a ciegas", async () => {
    expect(await submitWith({ provider: "none" }).service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "unavailable" });
    const noAsset = submitWith({ assets: { kind: "ok", assets: [{ lesson: LESSON, provider: "mux", asset: null }] } });
    expect(await noAsset.service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "unavailable" });
    expect(noAsset.calls).not.toContain("enviar");
  });

  it("lo que dice la base de los assets se contesta tal cual", async () => {
    const { service, calls } = submitWith({ assets: { kind: "not_editable" } });
    expect(await service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "not_editable" });
    expect(calls).toEqual(["guarda", "assets"]);
  });

  it("lo que contesta la base al enviar se contesta tal cual", async () => {
    expect(await submitWith({ answer: "changed" }).service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "changed" });
  });

  it("si la base no contestó: unknown, y se reporta", async () => {
    const { service, reported } = submitWith({ answer: "throws" });
    expect(await service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "unknown" });
    expect(reported).toEqual(["course_submit_unavailable"]);
  });

  it("si Mux lanza, también: no se supo", async () => {
    const { service, reported } = submitWith({ read: "throws" });
    expect(await service.submitCourse(reader, INPUT, ORIGIN)).toEqual({ kind: "unknown" });
    expect(reported).toEqual(["course_submit_unavailable"]);
  });
});

describe("las lecturas", () => {
  it("un id sin forma no llega a la base", async () => {
    const { service, store } = submitWith();
    expect(await service.submitPreview(claims, "x")).toEqual({ kind: "ready", value: { kind: "not_found" } });
    expect(await service.annexText(claims, "x")).toEqual({ kind: "ready", value: null });
    expect(store.preview).not.toHaveBeenCalled();
    expect(store.annex).not.toHaveBeenCalled();
  });

  it("si no se pudo leer, no se supo, y se reporta", async () => {
    const { service, store, reported } = submitWith();
    vi.mocked(store.accepted).mockRejectedValueOnce(new Error("sin base"));
    expect(await service.acceptedAnnexes(claims)).toEqual({ kind: "unavailable" });
    expect(reported).toEqual(["draft_read_unavailable"]);
  });
});
