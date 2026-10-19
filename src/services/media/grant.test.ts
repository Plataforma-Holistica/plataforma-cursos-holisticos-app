import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";

import { createMediaGrant } from "./grant";
import type { LessonVideo, OpenedPlayback, PlaybackOpening, Presence, WatchFacts } from "./records";

// La función única de medios, con todo lo de fuera simulado: a quién se le pregunta qué, en
// qué orden, y qué se contesta. Contra la base de verdad, en
// tests/integration/38-medios.test.ts (revisar) y 39-medios-ver.test.ts (ver).

const LESSON = "b0000000-0000-4000-8000-000000000002";
const TEACHER = "c0000000-0000-4000-8000-000000000003";
const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const READY: LessonVideo = {
  isCurrent: true,
  durationSeconds: 600,
  provider: "mux",
  ready: true,
  playbackId: "PlaybackDeLaBase",
  teacherId: TEACHER,
  courseState: "in_review",
  listed: false,
  isOpen: false,
};
const KEY = { id: "LlaveDePrueba01", privateKey: "llave" };
const TOKENS = { video: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" };
const NOW = 1_800_000_000;
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const DB_NOW = new Date("2026-10-15T12:00:00.000Z");
const IN_A_MONTH = new Date("2026-11-15T12:00:00.000Z");

/** Los hechos de una alumna con suscripción, de una lección publicada y listada. */
const PAYING: WatchFacts = {
  now: DB_NOW,
  viewer: { accountSuspended: false, content: false, teacherId: null, emailVerified: true },
  account: { suspended: false, paidThrough: IN_A_MONTH, lastRenewalFailedAt: null, endedAt: null, refunded: false, courtesy: [] },
  graceDays: 0,
  email: "ana@correo.com",
  lesson: { isCurrent: true, provider: "mux", ready: true, durationSeconds: 600, teacherId: TEACHER, courseState: "published", listed: true, isOpen: false },
  playbackId: "PlaybackDeLaBase",
};
const NEVER_PAID: WatchFacts = { ...PAYING, account: { ...PAYING.account, paidThrough: null } };
const PLAYBACK = "d0000000-0000-4000-8000-000000000004";
const OTHER_PLAYBACK = "d0000000-0000-4000-8000-000000000005";
const OPENED: OpenedPlayback = { kind: "opened", sessionId: PLAYBACK, heartbeatSeconds: 30 };
const STARTED = new Date("2026-10-15T11:40:00.000Z");
const LIVE_ROW = {
  sessionId: OTHER_PLAYBACK,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  lessonTitle: "Respirar",
  courseTitle: "Yoga suave",
  startedAt: STARTED,
};
const LIVE_SEEN = {
  sessionId: OTHER_PLAYBACK,
  device: { browser: "chrome", system: "windows" },
  lessonTitle: "Respirar",
  courseTitle: "Yoga suave",
  startedAt: STARTED,
};

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: "f" }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["content"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function grantWith(
  setup: {
    check?: TeamCheck;
    session?: SessionCheck;
    lesson?: LessonVideo | null | "throws";
    facts?: WatchFacts | null | "throws";
    speeds?: { minimum: number; maximum: number } | null | "throws";
    key?: typeof KEY | null;
    tokens?: typeof TOKENS | null;
    opened?: OpenedPlayback | null | "throws";
    presence?: Presence | null | "throws";
  } = {},
) {
  const calls: string[] = [];
  const openings: PlaybackOpening[] = [];
  const reported: string[] = [];
  const sign = vi.fn(() => {
    calls.push("firma");
    return setup.tokens === undefined ? TOKENS : setup.tokens;
  });
  const service = createMediaGrant(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: () => (calls.push("guarda del equipo"), Promise.resolve(setup.check ?? teamCheck())),
      checkSession: () => (calls.push("guarda de sesión"), Promise.resolve(setup.session ?? { kind: "pass", claims })),
      store: {
        lessonVideo: vi.fn((_claims: VerifiedClaims, id: string) => {
          calls.push(`lección ${id}`);
          if (setup.lesson === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.lesson === undefined ? READY : setup.lesson);
        }),
        watchFacts: vi.fn((_claims: VerifiedClaims, id: string) => {
          calls.push(`hechos ${id}`);
          if (setup.facts === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.facts === undefined ? PAYING : setup.facts);
        }),
        playbackSpeeds: vi.fn(() => {
          calls.push("velocidad");
          if (setup.speeds === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.speeds === undefined ? { minimum: 0.75, maximum: 2 } : setup.speeds);
        }),
        openPlayback: vi.fn((_claims: VerifiedClaims, opening: PlaybackOpening) => {
          calls.push("abre");
          openings.push(opening);
          if (setup.opened === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.opened === undefined ? OPENED : setup.opened);
        }),
        touchPlayback: vi.fn((_claims: VerifiedClaims, id: string) => {
          calls.push(`late ${id}`);
          if (setup.presence === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.presence === undefined ? { kind: "ok" as const } : setup.presence);
        }),
      },
      signingKey: () => (setup.key === undefined ? KEY : setup.key),
      sign,
      now: () => NOW,
    },
  );
  return { ...service, calls, reported, sign, openings };
}

const reader = { get: () => undefined };

describe("revisar: quién recibe una dirección firmada", () => {
  it("alguien del equipo con Contenido, para una lección lista: los tres tokens, con la vida de ADR-27, y el menú de velocidades", async () => {
    const service = grantWith();
    // Revisar nunca cuenta, y no habla de la cuenta: sin base, sin marca ni hasta cuándo.
    expect(await service.getMediaGrant(reader, LESSON, "review")).toEqual({
      kind: "granted",
      playbackId: "PlaybackDeLaBase",
      tokens: TOKENS,
      expiresAt: NOW + 800 + 600,
      speeds: RATES,
    });
    expect(service.calls).toEqual(["guarda del equipo", `lección ${LESSON}`, "velocidad", "firma"]);
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
    expect(await service.getMediaGrant(reader, LESSON, "review")).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda del equipo"]);
  });

  it("si no se supo quién pide: unavailable, sin intentar nada (la guarda ya reportó)", async () => {
    const service = grantWith({ check: { kind: "unavailable" } });
    expect(await service.getMediaGrant(reader, LESSON, "review")).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["guarda del equipo"]);
    expect(service.reported).toEqual([]);
  });

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
    expect(await service.getMediaGrant(reader, id, "review")).toEqual({ kind: "no_video" });
    expect(service.sign).not.toHaveBeenCalled();
    expect(service.reported).toEqual([]);
  });

  it.each<[string, Parameters<typeof grantWith>[0]]>([
    ["la base no contestó la lección", { lesson: "throws" }],
    ["falta la llave de firma", { key: null }],
    ["faltan las velocidades", { speeds: null }],
    ["la base no contestó las velocidades", { speeds: "throws" }],
    ["unas velocidades sin un paso entre ellas", { speeds: { minimum: 1.1, maximum: 1.2 } }],
    ["una velocidad mínima que no sirve", { speeds: { minimum: 0, maximum: 2 } }],
    ["la llave no sirve", { tokens: null }],
    ["una lección sin duración", { lesson: { ...READY, durationSeconds: 0 } }],
  ])("%s: unavailable, y se reporta", async (_what, setup) => {
    const service = grantWith(setup);
    expect(await service.getMediaGrant(reader, LESSON, "review")).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["media_grant_unavailable"]);
  });

  it("sin llave no pregunta la velocidad", async () => {
    const service = grantWith({ key: null });
    await service.getMediaGrant(reader, LESSON, "review");
    expect(service.calls).not.toContain("velocidad");
  });
});

describe("ver: la guarda de sesión primero", () => {
  it("una alumna que paga: firma, con su correo para la marca, las velocidades, la base, si cuenta y hasta cuándo", async () => {
    const service = grantWith();
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({
      kind: "granted",
      playbackId: "PlaybackDeLaBase",
      tokens: TOKENS,
      expiresAt: NOW + 1400,
      speeds: RATES,
      watermark: "ana@correo.com",
      basis: "subscription",
      countsForPayout: true,
      until: IN_A_MONTH,
      playbackSessionId: PLAYBACK,
      heartbeatSeconds: 30,
    });
    // La reproducción se abre al final, después de firmar (T-204).
    expect(service.calls).toEqual(["guarda de sesión", `hechos ${LESSON}`, "velocidad", "firma", "abre"]);
    // Nunca la guarda del equipo: ver no es revisar.
    expect(service.calls).not.toContain("guarda del equipo");
  });

  it.each<[string, SessionCheck, string]>([
    ["sin sesión", { kind: "anonymous" }, "refused"],
    ["una cuenta a la que le falta algo", { kind: "incomplete", claims } as SessionCheck, "refused"],
    ["una sesión que hay que cerrar", { kind: "must_sign_out", then: "sign_in" }, "refused"],
    ["una cuenta suspendida", { kind: "suspended" }, "suspended"],
    ["si no se supo (la guarda ya reportó)", { kind: "unavailable" }, "unavailable"],
  ])("%s: sin leer nada", async (_who, session, kind) => {
    const service = grantWith({ session });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({ kind });
    expect(service.calls).toEqual(["guarda de sesión"]);
    expect(service.reported).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["un id sin forma", "no-es-un-id"],
    ["algo que no es texto", { lesson: LESSON }],
  ])("%s: no_video, sin leer los hechos", async (_what, id) => {
    const service = grantWith();
    expect(await service.getMediaGrant(reader, id, "watch")).toEqual({ kind: "no_video" });
    expect(service.calls).toEqual(["guarda de sesión"]);
  });

  it("quien nunca pagó: denied, con el motivo de PA-33, sin firmar", async () => {
    const service = grantWith({ facts: NEVER_PAID });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({
      kind: "denied",
      account: { allowed: false, reason: "never_subscribed" },
    });
    expect(service.sign).not.toHaveBeenCalled();
  });

  it("con el periodo vencido: denied, con su fecha", async () => {
    const ended = new Date("2026-10-01T00:00:00.000Z");
    const service = grantWith({ facts: { ...PAYING, account: { ...PAYING.account, paidThrough: ended } } });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({
      kind: "denied",
      account: { allowed: false, reason: "expired", endedAt: ended },
    });
  });

  it("la hora es la de la base, no la del servidor", async () => {
    // Con la hora del servidor (2027) el periodo ya habría vencido.
    const service = grantWith();
    expect(NOW * 1000).toBeGreaterThan(IN_A_MONTH.getTime());
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toMatchObject({ kind: "granted", basis: "subscription" });
  });

  it("el maestro dueño ve lo suyo en revisión, sin cuenta pagada y sin puntos", async () => {
    const facts: WatchFacts = {
      ...NEVER_PAID,
      viewer: { ...NEVER_PAID.viewer, teacherId: TEACHER },
      lesson: { ...PAYING.lesson!, courseState: "in_review", listed: false },
    };
    expect(await grantWith({ facts }).getMediaGrant(reader, LESSON, "watch")).toMatchObject({
      kind: "granted",
      basis: "owner_preview",
      countsForPayout: false,
      until: null,
    });
  });

  it("el curso abierto, sin suscripción: firma, sin puntos", async () => {
    const facts: WatchFacts = { ...NEVER_PAID, lesson: { ...PAYING.lesson!, isOpen: true } };
    expect(await grantWith({ facts }).getMediaGrant(reader, LESSON, "watch")).toMatchObject({
      kind: "granted",
      basis: "open_course",
      countsForPayout: false,
    });
  });

  it.each<[string, WatchFacts]>([
    ["una lección que no existe", { ...PAYING, lesson: null, playbackId: null }],
    ["un curso que no se puede ver", { ...PAYING, lesson: { ...PAYING.lesson!, listed: false } }],
    ["un video de prueba", { ...PAYING, lesson: { ...PAYING.lesson!, provider: "test" } }],
  ])("%s: no_video, sin firmar ni reportar", async (_what, facts) => {
    const service = grantWith({ facts });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({ kind: "no_video" });
    expect(service.sign).not.toHaveBeenCalled();
    expect(service.reported).toEqual([]);
  });

  it("la cuenta suspendida según los hechos: suspended", async () => {
    const facts: WatchFacts = { ...PAYING, viewer: { ...PAYING.viewer, accountSuspended: true }, account: { ...PAYING.account, suspended: true } };
    expect(await grantWith({ facts }).getMediaGrant(reader, LESSON, "watch")).toEqual({ kind: "suspended" });
  });
});

describe("ver: lo que no se supo se reporta, y nunca pide pagar", () => {
  it.each<[string, Parameters<typeof grantWith>[0]]>([
    ["la base no contestó los hechos", { facts: "throws" }],
    ["la base no reconoce a quien actúa", { facts: null }],
    [
      "una falla de cobro sin la gracia de esa hora",
      { facts: { ...PAYING, account: { ...PAYING.account, paidThrough: new Date("2026-10-10T00:00:00.000Z"), lastRenewalFailedAt: new Date("2026-10-10T00:00:00.000Z") }, graceDays: Number.NaN } },
    ],
    ["una fecha que no es fecha", { facts: { ...PAYING, now: new Date(Number.NaN) } }],
    ["la regla dio acceso y la base no soltó el video", { facts: { ...PAYING, playbackId: null } }],
  ])("%s: unavailable, sin firmar", async (_what, setup) => {
    const service = grantWith(setup);
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["media_facts_unavailable"]);
    expect(service.sign).not.toHaveBeenCalled();
  });

  it("falta la llave: unavailable, como al revisar", async () => {
    const service = grantWith({ key: null });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["media_grant_unavailable"]);
  });

  it("un correo sin verificar se reporta, y la regla sigue sin abrirle el curso abierto", async () => {
    const facts: WatchFacts = { ...NEVER_PAID, viewer: { ...NEVER_PAID.viewer, emailVerified: false }, lesson: { ...PAYING.lesson!, isOpen: true } };
    const service = grantWith({ facts });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toMatchObject({ kind: "denied" });
    expect(service.reported).toEqual(["media_email_unverified"]);
  });
});

describe("ver: la marca de agua (RF-305)", () => {
  it.each<[string, unknown]>([
    ["sin correo", null],
    ["un correo vacío", ""],
    ["un correo sin arroba", "ana.correo.com"],
  ])("%s: unavailable, se reporta y no se firma: sin marca no hay video", async (_what, email) => {
    const service = grantWith({ facts: { ...PAYING, email: email as string | null } });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["media_watermark_unavailable"]);
    expect(service.sign).not.toHaveBeenCalled();
  });

  it("un correo que no sirve no cambia lo que se le dice a quien no tiene acceso: PA-33, no PA-18", async () => {
    const service = grantWith({ facts: { ...NEVER_PAID, email: null } });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toMatchObject({ kind: "denied" });
    expect(service.reported).toEqual([]);
  });

  it("revisar no lleva marca (llega con T-405)", async () => {
    expect(await grantWith().getMediaGrant(reader, LESSON, "review")).not.toHaveProperty("watermark");
  });
});

describe("lessonAccess: decidir sin firmar (la página de la lección, al cargar)", () => {
  it("una alumna que paga: allowed, sin leer la velocidad ni firmar, y sin playback id ni base", async () => {
    const service = grantWith();
    expect(await service.lessonAccess(reader, LESSON)).toEqual({ kind: "allowed" });
    expect(service.calls).toEqual(["guarda de sesión", `hechos ${LESSON}`]);
    expect(service.sign).not.toHaveBeenCalled();
  });

  it.each<[string, Parameters<typeof grantWith>[0], unknown]>([
    ["quien nunca pagó", { facts: NEVER_PAID }, { kind: "denied", account: { allowed: false, reason: "never_subscribed" } }],
    ["una lección que no existe", { facts: { ...PAYING, lesson: null, playbackId: null } }, { kind: "no_video" }],
    ["un curso que no se puede ver", { facts: { ...PAYING, lesson: { ...PAYING.lesson!, listed: false } } }, { kind: "no_video" }],
    ["un id sin forma", {}, { kind: "no_video" }],
    ["la cuenta suspendida", { session: { kind: "suspended" } }, { kind: "suspended" }],
    ["sin sesión", { session: { kind: "anonymous" } }, { kind: "refused" }],
    ["si no se supo", { facts: "throws" }, { kind: "unavailable" }],
    ["la regla dio acceso y la base no soltó el video", { facts: { ...PAYING, playbackId: null } }, { kind: "unavailable" }],
  ])("%s: lo mismo que contestaría ver, sin firmar", async (what, setup, expected) => {
    const service = grantWith(setup);
    const id = what === "un id sin forma" ? "no-es-un-id" : LESSON;
    expect(await service.lessonAccess(reader, id)).toEqual(expected);
    expect(service.sign).not.toHaveBeenCalled();
    expect(service.calls).not.toContain("velocidad");
  });

  it("no mira la marca: eso es de firmar", async () => {
    const service = grantWith({ facts: { ...PAYING, email: null } });
    expect(await service.lessonAccess(reader, LESSON)).toEqual({ kind: "allowed" });
    expect(service.reported).toEqual([]);
  });

  it("contesta igual que ver para cada combinación de hechos", async () => {
    // La misma decisión, salvo firmar: lo que ver da, lessonAccess lo dice.
    const cases: WatchFacts[] = [
      PAYING,
      NEVER_PAID,
      { ...NEVER_PAID, lesson: { ...PAYING.lesson!, isOpen: true } },
      { ...NEVER_PAID, viewer: { ...NEVER_PAID.viewer, teacherId: TEACHER }, lesson: { ...PAYING.lesson!, listed: false, courseState: "withdrawn" } },
      { ...PAYING, viewer: { ...PAYING.viewer, accountSuspended: true }, account: { ...PAYING.account, suspended: true } },
      { ...PAYING, lesson: { ...PAYING.lesson!, ready: false } },
    ];
    for (const facts of cases) {
      const watched = await grantWith({ facts }).getMediaGrant(reader, LESSON, "watch");
      const decided = await grantWith({ facts }).lessonAccess(reader, LESSON);
      expect(decided).toEqual(watched.kind === "granted" ? { kind: "allowed" } : watched);
    }
  });
});

describe("desde dónde se pide", () => {
  it("algo que no es review ni watch: refused, sin preguntar nada", async () => {
    const service = grantWith();
    expect(await service.getMediaGrant(reader, LESSON, "otro" as "watch")).toEqual({ kind: "refused" });
    expect(service.calls).toEqual([]);
  });
});

describe("ver abre una reproducción (T-204, RF-107)", () => {
  it("con la lección, el video que se firmó, la base y si cuenta; sin nada que cerrar", async () => {
    const service = grantWith();
    await service.getMediaGrant(reader, LESSON, "watch");
    expect(service.openings).toEqual([
      { lessonId: LESSON, playbackId: "PlaybackDeLaBase", basis: "subscription", countsForPayout: true, closing: null },
    ]);
  });

  it("la vista previa del dueño también ocupa lugar, sin contar para el reparto", async () => {
    const facts: WatchFacts = { ...NEVER_PAID, viewer: { ...NEVER_PAID.viewer, teacherId: TEACHER } };
    const service = grantWith({ facts });
    await service.getMediaGrant(reader, LESSON, "watch");
    expect(service.openings).toMatchObject([{ basis: "owner_preview", countsForPayout: false }]);
  });

  it("la que se pide cerrar viaja a la base; algo que no es un id, no", async () => {
    const closing = grantWith();
    await closing.getMediaGrant(reader, LESSON, "watch", { closing: OTHER_PLAYBACK });
    expect(closing.openings[0]?.closing).toBe(OTHER_PLAYBACK);
    for (const odd of ["no-es-un-id", 7, { id: OTHER_PLAYBACK }, null]) {
      const service = grantWith();
      expect(await service.getMediaGrant(reader, LESSON, "watch", { closing: odd })).toMatchObject({ kind: "granted" });
      expect(service.openings[0]?.closing).toBeNull();
    }
  });

  it("con el lugar ocupado: busy, con el navegador descrito y sin la cabecera; no reporta", async () => {
    const service = grantWith({ opened: { kind: "busy", live: [LIVE_ROW, { ...LIVE_ROW, userAgent: null, lessonTitle: null }] } });
    const grant = await service.getMediaGrant(reader, LESSON, "watch");
    expect(grant).toEqual({
      kind: "busy",
      live: [LIVE_SEEN, { ...LIVE_SEEN, device: { browser: null, system: null }, lessonTitle: null }],
    });
    expect(JSON.stringify(grant)).not.toContain("Mozilla");
    expect(service.reported).toEqual([]);
  });

  it.each<[string, OpenedPlayback | null | "throws"]>([
    ["la base no contestó", "throws"],
    ["la base no reconoce la sesión que pasó la guarda", null],
    ["la lección cambió de video entre decidir y abrir", { kind: "not_found" }],
  ])("%s: unavailable y se reporta; la dirección firmada no sale", async (_what, opened) => {
    const service = grantWith({ opened });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["playback_unavailable"]);
  });

  it.each<[string, Parameters<typeof grantWith>[0]]>([
    ["sin acceso", { facts: NEVER_PAID }],
    ["sin marca", { facts: { ...PAYING, email: null } }],
    ["sin llave", { key: null }],
    ["si la firma falla", { tokens: null }],
    ["una cuenta suspendida", { session: { kind: "suspended" } }],
  ])("%s: no abre nada, y no ocupa lugar", async (_what, setup) => {
    const service = grantWith(setup);
    expect(await service.getMediaGrant(reader, LESSON, "watch")).not.toMatchObject({ kind: "granted" });
    expect(service.calls).not.toContain("abre");
  });

  it("revisar y decidir al cargar no abren reproducción", async () => {
    const service = grantWith();
    await service.getMediaGrant(reader, LESSON, "review");
    await service.lessonAccess(reader, LESSON);
    expect(service.calls).not.toContain("abre");
  });
});

describe("el latido de presencia (T-204)", () => {
  it("con la sesión que pasa: late esa reproducción, y sigue", async () => {
    const service = grantWith();
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind: "ok" });
    expect(service.calls).toEqual(["guarda de sesión", `late ${PLAYBACK}`]);
    expect(service.reported).toEqual([]);
  });

  it("a una cuenta a la que le falta algo se le deja acabar (decisión de Sergio del 2026-10-19)", async () => {
    const service = grantWith({ session: { kind: "incomplete", claims } as SessionCheck });
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind: "ok" });
    expect(service.calls).toContain(`late ${PLAYBACK}`);
  });

  it.each<[string, SessionCheck, string]>([
    ["sin sesión", { kind: "anonymous" }, "refused"],
    ["una sesión que hay que cerrar", { kind: "must_sign_out", then: "sign_in" }, "refused"],
    ["una cuenta suspendida", { kind: "suspended" }, "suspended"],
    ["si no se supo (la guarda ya reportó)", { kind: "unavailable" }, "unavailable"],
  ])("%s: %s, sin latir", async (_who, session, kind) => {
    const service = grantWith({ session });
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind });
    expect(service.calls).toEqual(["guarda de sesión"]);
    expect(service.reported).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["un id sin forma", "no-es-un-id"],
    ["algo que no es texto", { id: PLAYBACK }],
  ])("%s: refused, sin latir", async (_what, id) => {
    const service = grantWith();
    expect(await service.playbackPresence(reader, id)).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda de sesión"]);
  });

  it("vencida y con el lugar tomado: busy, con el navegador descrito", async () => {
    const service = grantWith({ presence: { kind: "busy", live: [LIVE_ROW] } });
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind: "busy", live: [LIVE_SEEN] });
  });

  it("revocada: con su motivo y la que tomó su lugar", async () => {
    const service = grantWith({ presence: { kind: "revoked", reason: "closed_by_user", by: OTHER_PLAYBACK } });
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind: "revoked", reason: "closed_by_user", by: OTHER_PLAYBACK });
    expect(service.reported).toEqual([]);
  });

  it("una que no es de esta sesión: refused, sin reportar", async () => {
    const service = grantWith({ presence: { kind: "not_found" } });
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind: "refused" });
    expect(service.reported).toEqual([]);
  });

  it.each<[string, Presence | null | "throws"]>([
    ["la base no contestó", "throws"],
    ["la base no reconoce la sesión que pasó la guarda", null],
  ])("%s: unavailable y se reporta; el video sigue", async (_what, presence) => {
    const service = grantWith({ presence });
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["playback_unavailable"]);
  });

  it("no lee los hechos ni mira el acceso: el fin del acceso no detiene el video (T-202)", async () => {
    const service = grantWith({ facts: NEVER_PAID });
    expect(await service.playbackPresence(reader, PLAYBACK)).toEqual({ kind: "ok" });
    expect(service.calls).not.toContain(`hechos ${LESSON}`);
  });
});
