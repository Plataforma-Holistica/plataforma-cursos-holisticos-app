import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";

import { createMediaGrant } from "./grant";
import type { LessonVideo } from "./records";

// La función única de medios, con todo lo de fuera simulado: a quién se le pregunta qué, en
// qué orden, y qué se contesta. Contra la base de verdad, en
// tests/integration/38-medios.test.ts.

const LESSON = "b0000000-0000-4000-8000-000000000002";
const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const READY: LessonVideo = { isCurrent: true, durationSeconds: 600, provider: "mux", ready: true, playbackId: "PlaybackDeLaBase" };
const KEY = { id: "LlaveDePrueba01", privateKey: "llave" };
const TOKENS = { video: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" };
const NOW = 1_800_000_000;

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: "f" }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["content"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function grantWith(
  setup: {
    check?: TeamCheck;
    lesson?: LessonVideo | null | "throws";
    speed?: number | null | "throws";
    key?: typeof KEY | null;
    tokens?: typeof TOKENS | null;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const sign = vi.fn(() => {
    calls.push("firma");
    return setup.tokens === undefined ? TOKENS : setup.tokens;
  });
  const service = createMediaGrant(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: () => (calls.push("guarda"), Promise.resolve(setup.check ?? teamCheck())),
      store: {
        lessonVideo: vi.fn((_claims: VerifiedClaims, id: string) => {
          calls.push(`lección ${id}`);
          if (setup.lesson === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.lesson === undefined ? READY : setup.lesson);
        }),
        minimumSpeed: vi.fn(() => {
          calls.push("velocidad");
          if (setup.speed === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.speed === undefined ? 0.75 : setup.speed);
        }),
      },
      signingKey: () => (setup.key === undefined ? KEY : setup.key),
      sign,
      now: () => NOW,
    },
  );
  return { ...service, calls, reported, sign };
}

const reader = { get: () => undefined };

describe("quién recibe una dirección firmada", () => {
  it("alguien del equipo con Contenido, para una lección lista: los tres tokens, con la vida de ADR-27", async () => {
    const service = grantWith();
    expect(await service.getMediaGrant(reader, LESSON)).toEqual({
      kind: "granted",
      playbackId: "PlaybackDeLaBase",
      tokens: TOKENS,
      expiresAt: NOW + 800 + 600,
    });
    expect(service.calls).toEqual(["guarda", `lección ${LESSON}`, "velocidad", "firma"]);
    // El playback id es el de la base, y la llave, la de la configuración.
    expect(service.sign).toHaveBeenCalledExactlyOnceWith({ playbackId: "PlaybackDeLaBase", expiresAt: NOW + 1400, key: KEY });
  });

  it.each<[string, TeamCheck]>([
    ["sin sesión", { kind: "anonymous" }],
    ["una cuenta común", teamCheck({ state: "none" } as TeamStanding)],
    ["una invitada", teamCheck({ state: "invited", kind: "grant", capabilities: ["content"] } as unknown as TeamStanding)],
    ["alguien sin código", teamCheck({ state: "needs_code", factor: "f" } as TeamStanding)],
    ["alguien del equipo sin Contenido", teamCheck(standingOf(["config", "support"]))],
  ])("%s: refused, sin leer nada ni decir si la lección existe", async (_who, check) => {
    const service = grantWith({ check });
    expect(await service.getMediaGrant(reader, LESSON)).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("si no se supo quién pide: unavailable, sin intentar nada (la guarda ya reportó)", async () => {
    const service = grantWith({ check: { kind: "unavailable" } });
    expect(await service.getMediaGrant(reader, LESSON)).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["guarda"]);
    expect(service.reported).toEqual([]);
  });
});

describe("la misma respuesta cuando no hay video que firmar", () => {
  it.each<[string, unknown, LessonVideo | null | undefined]>([
    ["un id sin forma", "no-es-un-id", undefined],
    ["un id en mayúsculas", LESSON.toUpperCase(), undefined],
    ["algo que no es texto", 7, undefined],
    ["una lección que no existe o no se ve", LESSON, null],
    ["una retirada", LESSON, { ...READY, isCurrent: false }],
    ["una con video de prueba", LESSON, { ...READY, provider: "test" }],
    ["una con video sin terminar", LESSON, { ...READY, ready: false }],
    ["una sin playback id", LESSON, { ...READY, playbackId: null }],
  ])("%s: no_video, sin firmar ni reportar", async (_what, id, lesson) => {
    const service = grantWith({ lesson });
    expect(await service.getMediaGrant(reader, id)).toEqual({ kind: "no_video" });
    expect(service.sign).not.toHaveBeenCalled();
    expect(service.reported).toEqual([]);
  });
});

describe("lo que no se supo se reporta, y nunca se pinta como hecho", () => {
  it.each<[string, Parameters<typeof grantWith>[0]]>([
    ["la base no contestó la lección", { lesson: "throws" }],
    ["falta la llave de firma", { key: null }],
    ["falta la velocidad mínima", { speed: null }],
    ["la base no contestó la velocidad", { speed: "throws" }],
    ["la llave no sirve", { tokens: null }],
    ["una lección sin duración", { lesson: { ...READY, durationSeconds: 0 } }],
  ])("%s: unavailable", async (_what, setup) => {
    const service = grantWith(setup);
    expect(await service.getMediaGrant(reader, LESSON)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["media_grant_unavailable"]);
  });

  it("sin llave no pregunta la velocidad", async () => {
    const service = grantWith({ key: null });
    await service.getMediaGrant(reader, LESSON);
    expect(service.calls).not.toContain("velocidad");
  });
});
