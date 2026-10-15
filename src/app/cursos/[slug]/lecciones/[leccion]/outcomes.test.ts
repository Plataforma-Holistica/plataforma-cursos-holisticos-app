import { describe, expect, it } from "vitest";

import { denialOf, initialOf, watchAnswerOf } from "./outcomes";

// La tabla de la página de una lección (PA-22, T-203): lo que contesta la función única de
// medios, al cargar (`lessonAccess`) y al reproducir (`getMediaGrant`), traducido a lo que se
// pinta en el lugar del reproductor.

const TOKENS = { video: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" };
const ENDED = new Date("2026-10-01T18:00:00.000Z");

describe("el motivo de PA-33, con la fecha ya en palabras", () => {
  it.each([
    [{ allowed: false, reason: "never_subscribed" } as const, { reason: "never_subscribed" }],
    [{ allowed: false, reason: "expired", endedAt: ENDED } as const, { reason: "expired", date: "1 de octubre de 2026" }],
    [{ allowed: false, reason: "grace_ended", endedAt: ENDED } as const, { reason: "grace_ended", date: "1 de octubre de 2026" }],
    [{ allowed: false, reason: "refunded", endedAt: ENDED } as const, { reason: "refunded", date: "1 de octubre de 2026" }],
  ])("%j", (account, expected) => {
    expect(denialOf(account)).toEqual(expected);
  });

  it("la fecha es la del centro de México: un fin a las 3 de la mañana en UTC es del día anterior", () => {
    expect(denialOf({ allowed: false, reason: "expired", endedAt: new Date("2026-10-02T03:00:00.000Z") })).toEqual({
      reason: "expired",
      date: "1 de octubre de 2026",
    });
  });
});

describe("al cargar: lo que dijo lessonAccess", () => {
  it.each([
    [{ kind: "allowed" }, { kind: "ready" }],
    [{ kind: "denied", account: { allowed: false, reason: "never_subscribed" } }, { kind: "denied", denial: { reason: "never_subscribed" } }],
    [{ kind: "no_video" }, { kind: "no_video" }],
    [{ kind: "unavailable" }, { kind: "unavailable" }],
    [{ kind: "suspended" }, { kind: "suspended" }],
    // La sesión dejó de pasar entre la guarda de la página y esta pregunta: que decida la guarda.
    [{ kind: "refused" }, { kind: "reload" }],
    // El tipo admite una cuenta suspendida como rechazo; es PA-35, nunca PA-33.
    [{ kind: "denied", account: { allowed: false, reason: "suspended" } }, { kind: "suspended" }],
  ] as const)("%j", (access, expected) => {
    expect(initialOf(access)).toEqual(expected);
  });
});

describe("al reproducir: lo que dijo getMediaGrant", () => {
  it("con acceso: el video, sus tokens con los nombres de Mux Player, las velocidades y la marca; nada de la base de acceso", () => {
    const answer = watchAnswerOf({
      kind: "granted",
      playbackId: "PlaybackDePrueba",
      tokens: TOKENS,
      expiresAt: 99,
      speeds: [1, 1.25],
      watermark: "ana@correo.com",
      basis: "subscription",
      countsForPayout: true,
      until: ENDED,
    });
    expect(answer).toEqual({
      kind: "granted",
      playbackId: "PlaybackDePrueba",
      tokens: { playback: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" },
      speeds: [1, 1.25],
      watermark: "ana@correo.com",
    });
  });

  it.each([
    [{ kind: "denied", account: { allowed: false, reason: "refunded", endedAt: ENDED } }, { kind: "denied", denial: { reason: "refunded", date: "1 de octubre de 2026" } }],
    [{ kind: "no_video" }, { kind: "no_video" }],
    [{ kind: "unavailable" }, { kind: "unavailable" }],
    // Suspendida o sin una sesión que pase: a la misma página, donde decide la guarda.
    [{ kind: "suspended" }, { kind: "reload" }],
    [{ kind: "refused" }, { kind: "reload" }],
    [{ kind: "denied", account: { allowed: false, reason: "suspended" } }, { kind: "reload" }],
  ] as const)("%j", (grant, expected) => {
    expect(watchAnswerOf(grant)).toEqual(expected);
  });
});
