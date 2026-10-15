import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";

import { createMediaGrant } from "./grant";
import type { LessonVideo, WatchFacts } from "./records";

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
      },
      signingKey: () => (setup.key === undefined ? KEY : setup.key),
      sign,
      now: () => NOW,
    },
  );
  return { ...service, calls, reported, sign };
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
    });
    expect(service.calls).toEqual(["guarda de sesión", `hechos ${LESSON}`, "velocidad", "firma"]);
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
