import { describe, expect, it } from "vitest";

import type { BatchAnswer } from "@/services/media/media";

import { denialOf, heartbeatReplyOf, initialOf, presenceReplyOf, watchAnswerOf } from "./outcomes";

// La tabla de la página de una lección (PA-22, T-203): lo que contesta la función única de
// medios, al cargar (`lessonAccess`) y al reproducir (`getMediaGrant`), traducido a lo que se
// pinta en el lugar del reproductor.

const TOKENS = { video: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" };
const ENDED = new Date("2026-10-01T18:00:00.000Z");
const PLAYBACK = "d0000000-0000-4000-8000-000000000004";
const OTHER = "d0000000-0000-4000-8000-000000000005";
const LIVE = [
  {
    sessionId: OTHER,
    device: { browser: "safari", system: "ios" } as const,
    lessonTitle: "Respirar",
    courseTitle: "Yoga suave",
    startedAt: new Date("2026-10-19T01:40:00.000Z"),
  },
];
const ROWS = [
  { sessionId: OTHER, browser: "safari", system: "ios", lesson: "Respirar", course: "Yoga suave", since: "2026-10-19T01:40:00.000Z" },
];

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
  it("con acceso: el video, sus tokens con los nombres de Mux Player, las velocidades, la marca y su reproducción; nada de la base de acceso", () => {
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
      playbackSessionId: PLAYBACK,
      heartbeatSeconds: 30,
      durationSeconds: 356,
    });
    expect(answer).toEqual({
      kind: "granted",
      playbackId: "PlaybackDePrueba",
      tokens: { playback: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" },
      speeds: [1, 1.25],
      watermark: "ana@correo.com",
      playbackSessionId: PLAYBACK,
      heartbeatSeconds: 30,
      durationSeconds: 356,
    });
  });

  it("con el lugar ocupado en otro navegador: la lista de PA-34, con la hora en ISO", () => {
    expect(watchAnswerOf({ kind: "busy", live: LIVE })).toEqual({ kind: "busy", live: ROWS });
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

describe("el latido de presencia (T-204): lo que dijo playbackPresence", () => {
  it.each([
    [{ kind: "ok" }, { kind: "ok" }],
    // No se supo: el video sigue.
    [{ kind: "unavailable" }, { kind: "unavailable" }],
    [{ kind: "busy", live: LIVE }, { kind: "busy", live: ROWS }],
    // Cerrada desde PA-34 de otro dispositivo, o abierta en otra pestaña: con la que tomó su lugar.
    [{ kind: "revoked", reason: "closed_by_user", by: OTHER }, { kind: "closed", from: "device", by: OTHER }],
    [{ kind: "revoked", reason: "replaced", by: OTHER }, { kind: "closed", from: "tab", by: OTHER }],
    [{ kind: "revoked", reason: "replaced", by: null }, { kind: "closed", from: "tab", by: null }],
    // La sesión se cerró, o un motivo del equipo: a la página, donde decide la guarda.
    [{ kind: "revoked", reason: "session_closed", by: null }, { kind: "reload" }],
    [{ kind: "revoked", reason: "access_lost", by: null }, { kind: "reload" }],
    [{ kind: "revoked", reason: "admin", by: null }, { kind: "reload" }],
    [{ kind: "suspended" }, { kind: "reload" }],
    [{ kind: "refused" }, { kind: "reload" }],
  ] as const)("%j", (answer, expected) => {
    expect(presenceReplyOf(answer)).toEqual(expected);
  });
});

describe("el latido con los tramos vistos (T-205): lo que dijo playbackHeartbeat", () => {
  it.each<[BatchAnswer | null]>([[null], [{ kind: "settled", seqs: [0, 1, 2] }], [{ kind: "discard" }], [{ kind: "retry" }]])(
    "lo del lote va tal cual junto a lo de la presencia: %j",
    (batch) => {
    expect(heartbeatReplyOf({ presence: { kind: "ok" }, batch })).toEqual({ kind: "ok", batch });
    expect(heartbeatReplyOf({ presence: { kind: "revoked", reason: "replaced", by: OTHER }, batch })).toEqual({
      kind: "closed",
      from: "tab",
      by: OTHER,
      batch,
    });
    },
  );

  it("si la presencia vuelve a la página, el lote no viaja: se queda en la cola", () => {
    expect(heartbeatReplyOf({ presence: { kind: "suspended" }, batch: { kind: "retry" } })).toEqual({ kind: "reload" });
  });
});
