import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { Capability, TeamCheck, TeamStanding } from "@/services/account/team";

import { createMediaGrant } from "./grant";
import type { BatchRecord, DownloadHit, HeartbeatBeat, LessonVideo, OpenedPlayback, PlaybackOpening, Presence, ResourceFacts, ResourceFile, WatchFacts } from "./records";

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
const OPENED: OpenedPlayback = { kind: "opened", sessionId: PLAYBACK, heartbeatSeconds: 30, position: null };
const STARTED = new Date("2026-10-15T11:40:00.000Z");
/** La hora del tope del reloj de la reproducción, que da la base: con ella se decide si el lote cuenta. */
const AT = new Date("2026-10-15T11:59:30.000Z");
const EVENTS = [
  { seq: 0, from: 0, to: 30, rate: 1, visible: true },
  { seq: 1, from: 30, to: 60, rate: 1, visible: true },
];
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

const RESOURCE = "e0000000-0000-4000-8000-000000000006";
const COURSE = "e0000000-0000-4000-8000-000000000007";
const FILE: ResourceFile = { path: `${TEACHER}/${COURSE}/${RESOURCE}`, mime: "application/pdf", title: "Guía" };
const DOWNLOAD_URL = "https://storage/bajar?token=t";
const RESOURCE_PAYING: ResourceFacts = {
  now: DB_NOW,
  viewer: PAYING.viewer,
  account: PAYING.account,
  graceDays: 0,
  resource: { isCurrent: true, teacherId: TEACHER, courseState: "published", listed: true, isOpen: false },
  file: FILE,
};
const RESOURCE_NEVER_PAID: ResourceFacts = { ...RESOURCE_PAYING, account: NEVER_PAID.account };

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
    /** Los hechos con que la base le pregunta a la regla si el lote cuenta; nulo: no se pudieron leer. */
    beatFacts?: WatchFacts | null;
    /** Lo que la base contesta del lote, si la regla supo decidir; `throws`: el lote tumba la transacción. */
    recorded?: BatchRecord | "throws";
    resourceFacts?: ResourceFacts | null | "throws";
    draftFile?: ResourceFile | null | "throws";
    hit?: DownloadHit | "throws";
    downloadUrl?: string | null;
  } = {},
) {
  const calls: string[] = [];
  const openings: PlaybackOpening[] = [];
  const beats: HeartbeatBeat[] = [];
  const decisions: string[] = [];
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
        resourceFacts: vi.fn((_claims: VerifiedClaims, id: string) => {
          calls.push(`recurso ${id}`);
          if (setup.resourceFacts === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.resourceFacts === undefined ? RESOURCE_PAYING : setup.resourceFacts);
        }),
        draftResourceFile: vi.fn((_claims: VerifiedClaims, course: string, id: string) => {
          calls.push(`borrador ${course} ${id}`);
          if (setup.draftFile === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.draftFile === undefined ? FILE : setup.draftFile);
        }),
        downloadHit: vi.fn(() => {
          calls.push("freno");
          if (setup.hit === "throws") return Promise.reject(new Error("sin base"));
          return Promise.resolve(setup.hit ?? "ok");
        }),
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
        // Como `recordHeartbeat`: la presencia si se pide, y el lote si trae algo, con la regla
        // preguntada a la hora del tope del reloj (`AT`).
        heartbeat: vi.fn((_claims: VerifiedClaims, beat: HeartbeatBeat) => {
          beats.push(beat);
          if (beat.presence) calls.push(`late ${beat.sessionId}`);
          if (setup.presence === "throws") return Promise.reject(new Error("sin base"));
          if (beat.presence && setup.presence === null) return Promise.resolve(null);
          let batch: BatchRecord | null = null;
          if (beat.events.length > 0) {
            calls.push(`registra ${beat.sessionId}`);
            if (setup.recorded === "throws") return Promise.reject(new Error("consulta cancelada"));
            const facts = setup.beatFacts === undefined ? PAYING : setup.beatFacts;
            const counts = facts === null ? "unknown" : beat.decide(facts, AT);
            decisions.push(counts);
            batch =
              counts === "unknown"
                ? { kind: "unknown" }
                : (setup.recorded ?? { kind: "recorded", accepted: beat.events.map((each) => each.seq), duplicate: [], rejected: [], progress: null });
          }
          return Promise.resolve({ presence: beat.presence ? (setup.presence ?? { kind: "ok" as const }) : null, batch });
        }),
      },
      signingKey: () => (setup.key === undefined ? KEY : setup.key),
      sign,
      files: {
        signDownload: vi.fn((file: ResourceFile) => {
          calls.push(`firma ${file.path}`);
          return Promise.resolve(setup.downloadUrl === undefined ? DOWNLOAD_URL : setup.downloadUrl);
        }),
      },
      now: () => NOW,
    },
  );
  return { ...service, calls, reported, sign, openings, beats, decisions };
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
      durationSeconds: 600,
      startSeconds: 0,
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

  it("la sesión se cerró mientras se abría: refused, sin reportar; la página decide", async () => {
    const service = grantWith({ opened: { kind: "session_closed" } });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toEqual({ kind: "refused" });
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
    expect(await service.playbackHeartbeat(reader, PLAYBACK)).toEqual({ presence: { kind: "ok" }, batch: null });
    expect(service.calls).toEqual(["guarda de sesión", `late ${PLAYBACK}`]);
    expect(service.beats[0]).toMatchObject({ sessionId: PLAYBACK, presence: true, events: [] });
    expect(service.reported).toEqual([]);
  });

  it("a una cuenta a la que le falta algo se le deja acabar (decisión de Sergio del 2026-10-19)", async () => {
    const service = grantWith({ session: { kind: "incomplete", claims } as SessionCheck });
    expect(await service.playbackHeartbeat(reader, PLAYBACK)).toEqual({ presence: { kind: "ok" }, batch: null });
    expect(service.calls).toContain(`late ${PLAYBACK}`);
  });

  it.each<[string, SessionCheck, string]>([
    ["sin sesión", { kind: "anonymous" }, "refused"],
    ["una sesión que hay que cerrar", { kind: "must_sign_out", then: "sign_in" }, "refused"],
    ["una cuenta suspendida", { kind: "suspended" }, "suspended"],
    ["si no se supo (la guarda ya reportó)", { kind: "unavailable" }, "unavailable"],
  ])("%s: %s, sin latir; los tramos se quedan en la cola", async (_who, session, kind) => {
    const service = grantWith({ session });
    expect(await service.playbackHeartbeat(reader, PLAYBACK)).toEqual({ presence: { kind }, batch: null });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({ presence: { kind }, batch: { kind: "retry" } });
    expect(service.calls).toEqual(["guarda de sesión", "guarda de sesión"]);
    expect(service.reported).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["un id sin forma", "no-es-un-id"],
    ["algo que no es texto", { id: PLAYBACK }],
  ])("%s: refused, sin latir; sus tramos no son de ninguna", async (_what, id) => {
    const service = grantWith();
    expect(await service.playbackHeartbeat(reader, id)).toEqual({ presence: { kind: "refused" }, batch: null });
    expect(await service.playbackHeartbeat(reader, id, EVENTS)).toEqual({ presence: { kind: "refused" }, batch: { kind: "discard" } });
    expect(service.calls).toEqual(["guarda de sesión", "guarda de sesión"]);
  });

  it("vencida y con el lugar tomado: busy, con el navegador descrito", async () => {
    const service = grantWith({ presence: { kind: "busy", live: [LIVE_ROW] } });
    expect(await service.playbackHeartbeat(reader, PLAYBACK)).toEqual({ presence: { kind: "busy", live: [LIVE_SEEN] }, batch: null });
  });

  it("revocada: con su motivo y la que tomó su lugar", async () => {
    const service = grantWith({ presence: { kind: "revoked", reason: "closed_by_user", by: OTHER_PLAYBACK } });
    expect(await service.playbackHeartbeat(reader, PLAYBACK)).toEqual({
      presence: { kind: "revoked", reason: "closed_by_user", by: OTHER_PLAYBACK },
      batch: null,
    });
    expect(service.reported).toEqual([]);
  });

  it("una que no es de esta sesión: refused, sin reportar", async () => {
    const service = grantWith({ presence: { kind: "not_found" } });
    expect(await service.playbackHeartbeat(reader, PLAYBACK)).toEqual({ presence: { kind: "refused" }, batch: null });
    expect(service.reported).toEqual([]);
  });

  it.each<[string, Presence | null | "throws"]>([
    ["la base no contestó", "throws"],
    ["la base no reconoce la sesión que pasó la guarda", null],
  ])("%s: unavailable y se reporta; el video sigue y los tramos se quedan", async (_what, presence) => {
    const service = grantWith({ presence });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({ presence: { kind: "unavailable" }, batch: { kind: "retry" } });
    expect(service.reported).toEqual(["playback_unavailable"]);
  });

  it("sin tramos no lee los hechos ni mira el acceso: el fin del acceso no detiene el video (T-202)", async () => {
    const service = grantWith({ facts: NEVER_PAID, beatFacts: NEVER_PAID });
    expect(await service.playbackHeartbeat(reader, PLAYBACK)).toEqual({ presence: { kind: "ok" }, batch: null });
    expect(service.calls).not.toContain(`hechos ${LESSON}`);
    expect(service.decisions).toEqual([]);
  });
});

describe("los tramos vistos (T-205, RF-401 a RF-403)", () => {
  it("van en el mismo latido que la presencia, y salen de la cola todos los que la base vio", async () => {
    const service = grantWith({
      recorded: { kind: "recorded", accepted: [2, 0], duplicate: [1], rejected: [{ seq: 3, reason: "faster_than_clock" }], progress: null },
    });
    const four = [...EVENTS, { seq: 2, from: 60, to: 90, rate: 1, visible: true }, { seq: 3, from: 90, to: 120, rate: 1, visible: true }];
    expect(await service.playbackHeartbeat(reader, PLAYBACK, four)).toEqual({ presence: { kind: "ok" }, batch: { kind: "settled", seqs: [0, 1, 2, 3], progress: null } });
    expect(service.calls).toEqual(["guarda de sesión", `late ${PLAYBACK}`, `registra ${PLAYBACK}`]);
    expect(service.beats).toHaveLength(1);
    expect(service.beats[0]).toMatchObject({ sessionId: PLAYBACK, presence: true, events: four });
    expect(service.reported).toEqual([]);
  });

  it("si la presencia dice que otro tomó el lugar, los tramos se registran igual: son de antes", async () => {
    const service = grantWith({ presence: { kind: "revoked", reason: "replaced", by: OTHER_PLAYBACK } });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({
      presence: { kind: "revoked", reason: "replaced", by: OTHER_PLAYBACK },
      batch: { kind: "settled", seqs: [0, 1], progress: null },
    });
  });

  it("un lote sin forma no se registra: lo enviado se tira, y la presencia late igual", async () => {
    const service = grantWith();
    expect(await service.playbackHeartbeat(reader, PLAYBACK, [{ ...EVENTS[0], to: 0 }])).toEqual({
      presence: { kind: "ok" },
      batch: { kind: "discard" },
    });
    expect(service.beats[0]).toMatchObject({ presence: true, events: [] });
    expect(service.calls).not.toContain(`registra ${PLAYBACK}`);
  });

  it("la reproducción no existe o no es de quien la manda: se tira, sin reportar", async () => {
    const service = grantWith({ recorded: { kind: "not_found" } });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({ presence: { kind: "ok" }, batch: { kind: "discard" } });
    expect(service.reported).toEqual([]);
  });

  it("si el lote tumba la transacción, la presencia se repite sola: la reproducción no vence", async () => {
    const service = grantWith({ recorded: "throws" });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({ presence: { kind: "ok" }, batch: { kind: "retry" } });
    expect(service.calls).toEqual(["guarda de sesión", `late ${PLAYBACK}`, `registra ${PLAYBACK}`, `late ${PLAYBACK}`]);
    expect(service.beats.map((each) => each.events.length)).toEqual([2, 0]);
    expect(service.reported).toEqual(["heartbeat_unavailable"]);
  });

  it("si tampoco la presencia sola contesta, no se supo: se reporta como la presencia", async () => {
    const service = grantWith({ presence: "throws" });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({ presence: { kind: "unavailable" }, batch: { kind: "retry" } });
    expect(service.beats).toHaveLength(2);
    expect(service.reported).toEqual(["playback_unavailable"]);
  });

  it("la base no pudo registrar: se queda en la cola y se reporta", async () => {
    const service = grantWith({ recorded: { kind: "failed", code: "23514" } });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({ presence: { kind: "ok" }, batch: { kind: "retry" } });
    expect(service.reported).toEqual(["heartbeat_unavailable"]);
  });

  // Si lo visto cuenta, con los hechos a la hora del tope del reloj, no a la de llegada.
  const facts = (change: Partial<WatchFacts>): WatchFacts => ({ ...PAYING, ...change });
  it.each<[string, WatchFacts | null, string]>([
    ["con suscripción a esa hora: cuenta", PAYING, "counts"],
    [
      "el periodo pagado terminó antes del tope: se guarda sin puntos (decisión de T-202)",
      facts({ account: { ...PAYING.account, paidThrough: new Date("2026-10-15T11:59:00.000Z") } }),
      "no",
    ],
    [
      "el periodo pagado termina después del tope, aunque ya pasó al llegar: cuenta",
      facts({ now: IN_A_MONTH, account: { ...PAYING.account, paidThrough: new Date("2026-10-15T12:00:00.000Z") } }),
      "counts",
    ],
    ["la lección se retiró: deja de contar (decisión de Sergio del 2026-10-19)", facts({ lesson: { ...PAYING.lesson!, isCurrent: false } }), "no"],
    ["cortesía: no cuenta", facts({ account: { ...PAYING.account, paidThrough: null, courtesy: [{ from: STARTED, until: null }] } }), "no"],
    ["la cuenta se suspendió: no cuenta", facts({ viewer: { ...PAYING.viewer, accountSuspended: true } }), "no"],
    [
      "con una falla de cobro y sin la gracia de esa hora: no se supo",
      facts({ account: { ...PAYING.account, paidThrough: new Date("2026-10-01T00:00:00.000Z"), lastRenewalFailedAt: STARTED }, graceDays: Number.NaN }),
      "unknown",
    ],
    ["los hechos no se pudieron leer: no se supo", null, "unknown"],
  ])("%s", async (_what, beatFacts, decision) => {
    const service = grantWith({ beatFacts });
    const answer = await service.playbackHeartbeat(reader, PLAYBACK, EVENTS);
    expect(service.decisions).toEqual([decision]);
    // «No se supo» no es «no cuenta»: no se registra, se queda en la cola, y se reporta.
    if (decision === "unknown") {
      expect(answer).toEqual({ presence: { kind: "ok" }, batch: { kind: "retry" } });
      expect(service.reported).toEqual(["heartbeat_unavailable"]);
    } else {
      expect(answer).toEqual({ presence: { kind: "ok" }, batch: { kind: "settled", seqs: [0, 1], progress: null } });
      expect(service.reported).toEqual([]);
    }
  });
});

describe("mandar los tramos sin presencia (T-205)", () => {
  it("no late: solo registra", async () => {
    const service = grantWith();
    expect(await service.flushHeartbeats(reader, PLAYBACK, EVENTS)).toEqual({ kind: "settled", seqs: [0, 1], progress: null });
    expect(service.calls).toEqual(["guarda de sesión", `registra ${PLAYBACK}`]);
    expect(service.beats[0]).toMatchObject({ sessionId: PLAYBACK, presence: false, events: EVENTS });
  });

  it("un lote vacío no le pregunta nada a la base", async () => {
    const service = grantWith();
    expect(await service.flushHeartbeats(reader, PLAYBACK, [])).toEqual({ kind: "settled", seqs: [], progress: null });
    expect(service.calls).toEqual(["guarda de sesión"]);
    expect(service.beats).toEqual([]);
  });

  it("a una cuenta a la que le falta algo también", async () => {
    const service = grantWith({ session: { kind: "incomplete", claims } as SessionCheck });
    expect(await service.flushHeartbeats(reader, PLAYBACK, EVENTS)).toEqual({ kind: "settled", seqs: [0, 1], progress: null });
  });

  it.each<[string, SessionCheck]>([
    ["sin sesión", { kind: "anonymous" }],
    ["una sesión que hay que cerrar", { kind: "must_sign_out", then: "sign_in" }],
    ["una cuenta suspendida", { kind: "suspended" }],
    ["si no se supo", { kind: "unavailable" }],
  ])("%s: se queda en la cola, sin preguntarle a la base", async (_who, session) => {
    const service = grantWith({ session });
    expect(await service.flushHeartbeats(reader, PLAYBACK, EVENTS)).toEqual({ kind: "retry" });
    expect(service.calls).toEqual(["guarda de sesión"]);
  });

  it.each<[string, unknown, unknown]>([
    ["un id sin forma", "no-es-un-id", EVENTS],
    ["un lote sin forma", PLAYBACK, { 0: EVENTS[0] }],
    ["sin lote", PLAYBACK, undefined],
  ])("%s: lo enviado se tira", async (_what, id, events) => {
    const service = grantWith();
    expect(await service.flushHeartbeats(reader, id, events)).toEqual({ kind: "discard" });
    expect(service.beats).toEqual([]);
  });

  it.each<[string, Parameters<typeof grantWith>[0], unknown, string[]]>([
    ["la reproducción no es de quien la manda: se tira", { recorded: { kind: "not_found" } }, { kind: "discard" }, []],
    ["la base no pudo: se queda y se reporta", { recorded: { kind: "failed", code: "23514" } }, { kind: "retry" }, ["heartbeat_unavailable"]],
    ["no se supo si cuenta: se queda y se reporta", { beatFacts: null }, { kind: "retry" }, ["heartbeat_unavailable"]],
    ["la base no contestó: se queda y se reporta", { presence: "throws" }, { kind: "retry" }, ["heartbeat_unavailable"]],
    ["el lote tumbó la transacción: se queda y se reporta", { recorded: "throws" }, { kind: "retry" }, ["heartbeat_unavailable"]],
  ])("%s", async (_what, setup, expected, reported) => {
    const service = grantWith(setup);
    expect(await service.flushHeartbeats(reader, PLAYBACK, EVENTS)).toEqual(expected);
    expect(service.reported).toEqual(reported);
  });
});

describe("el progreso (T-206, RF-307)", () => {
  const TRACKED = { kind: "tracked" as const, lessonId: LESSON, coveredSeconds: 540, completed: true, justCompleted: true };

  it.each<[string, number | null, number]>([
    ["sin nada guardado, desde el principio", null, 0],
    ["donde se quedó", 300, 300],
    ["le faltaba menos del 5 % de los 600 s: desde el principio", 571, 0],
  ])("ver arranca en el segundo guardado: %s", async (_case, position, start) => {
    const service = grantWith({ opened: { ...OPENED, position } });
    expect(await service.getMediaGrant(reader, LESSON, "watch")).toMatchObject({ kind: "granted", startSeconds: start });
  });

  it("el lote contesta el estado de la lección, para marcarla al momento", async () => {
    const service = grantWith({ recorded: { kind: "recorded", accepted: [0, 1], duplicate: [], rejected: [], progress: TRACKED } });
    const note = { lessonId: LESSON, coveredSeconds: 540, completed: true, justCompleted: true };
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({
      presence: { kind: "ok" },
      batch: { kind: "settled", seqs: [0, 1], progress: note },
    });
    expect(await service.flushHeartbeats(reader, PLAYBACK, EVENTS)).toEqual({ kind: "settled", seqs: [0, 1], progress: note });
    expect(service.reported).toEqual([]);
  });

  it("ya terminada de antes no es recién terminada", async () => {
    const service = grantWith({ recorded: { kind: "recorded", accepted: [0], duplicate: [], rejected: [], progress: { ...TRACKED, justCompleted: false } } });
    expect(await service.flushHeartbeats(reader, PLAYBACK, EVENTS)).toMatchObject({ progress: { completed: true, justCompleted: false } });
  });

  it("si el progreso falló, el lote igual sale de la cola: quedó en el libro, y se reporta", async () => {
    const service = grantWith({ recorded: { kind: "recorded", accepted: [0, 1], duplicate: [], rejected: [], progress: { kind: "failed", code: "P0001" } } });
    expect(await service.playbackHeartbeat(reader, PLAYBACK, EVENTS)).toEqual({
      presence: { kind: "ok" },
      batch: { kind: "settled", seqs: [0, 1], progress: null },
    });
    expect(await service.flushHeartbeats(reader, PLAYBACK, EVENTS)).toEqual({ kind: "settled", seqs: [0, 1], progress: null });
    expect(service.reported).toEqual(["progress_unavailable", "progress_unavailable"]);
  });
});

// Bajar un recurso (RF-308; T-404): la misma puerta y las reglas de ver, sin video. Nunca abre reproducción ni latidos.
describe("bajar un recurso", () => {
  it("con acceso: la guarda, los hechos, el freno y la firma, en ese orden", async () => {
    const service = grantWith();
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "granted", url: DOWNLOAD_URL });
    expect(service.calls).toEqual(["guarda de sesión", `recurso ${RESOURCE}`, "freno", `firma ${FILE.path}`]);
    expect(service.reported).toEqual([]);
    // Ni reproducción ni firma de video.
    expect(service.sign).not.toHaveBeenCalled();
    expect(service.openings).toEqual([]);
  });

  it.each<[string, SessionCheck, string]>([
    ["no se supo la sesión", { kind: "unavailable" }, "unavailable"],
    ["cuenta suspendida", { kind: "suspended" }, "suspended"],
    ["sin sesión", { kind: "anonymous" }, "refused"],
    ["cuenta a medias", { kind: "incomplete", claims } as unknown as SessionCheck, "refused"],
  ])("%s: no se lee nada", async (_name, session, kind) => {
    const service = grantWith({ session });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind });
    expect(service.calls).toEqual(["guarda de sesión"]);
  });

  it.each([["no es un texto", 7], ["no tiene forma", "x"], ["mayúsculas", RESOURCE.toUpperCase()], ["nulo", null]])("lo que llega %s: no llega a la base", async (_name, id) => {
    const service = grantWith();
    expect(await service.getResourceGrant(reader, id)).toEqual({ kind: "not_found" });
    expect(service.calls).toEqual(["guarda de sesión"]);
  });

  it("lo que no existe: `not_found`, sin freno ni firma", async () => {
    const service = grantWith({ resourceFacts: { ...RESOURCE_PAYING, resource: null, file: null } });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "not_found" });
    expect(service.calls).toEqual(["guarda de sesión", `recurso ${RESOURCE}`]);
  });

  it("sin acceso: el motivo para PA-33, sin freno ni firma, aunque la barrera soltara el archivo", async () => {
    const service = grantWith({ resourceFacts: RESOURCE_NEVER_PAID });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "denied", account: { allowed: false, reason: "never_subscribed" } });
    expect(service.calls).toEqual(["guarda de sesión", `recurso ${RESOURCE}`]);
  });

  it("cuenta suspendida según los hechos: `suspended`", async () => {
    const service = grantWith({ resourceFacts: { ...RESOURCE_PAYING, viewer: { ...RESOURCE_PAYING.viewer, accountSuspended: true } } });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "suspended" });
    expect(service.calls).not.toContain("freno");
  });

  it.each<[string, ResourceFacts | null | "throws", string]>([
    ["los hechos no se pudieron leer", "throws", "media_facts_unavailable"],
    ["la base no reconoce a quien actúa", null, "media_facts_unavailable"],
    ["sin un número de gracia, con falla de cobro", { ...RESOURCE_PAYING, graceDays: Number.NaN, account: { ...RESOURCE_PAYING.account, paidThrough: DB_NOW, lastRenewalFailedAt: DB_NOW } }, "media_facts_unavailable"],
    ["la regla dio acceso y la barrera no soltó el archivo", { ...RESOURCE_PAYING, file: null }, "resource_grant_unavailable"],
  ])("%s: «no se supo», reportado, sin firmar", async (_name, resourceFacts, code) => {
    const service = grantWith({ resourceFacts });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual([code]);
    expect(service.calls.filter((call) => call.startsWith("firma"))).toEqual([]);
    expect(service.calls).not.toContain("freno");
  });

  it("una cuenta sin el correo verificado se reporta, y la regla sigue", async () => {
    const service = grantWith({ resourceFacts: { ...RESOURCE_PAYING, viewer: { ...RESOURCE_PAYING.viewer, emailVerified: false } } });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "granted", url: DOWNLOAD_URL });
    expect(service.reported).toEqual(["media_email_unverified"]);
  });

  it("con el tope: `throttled`, sin firmar y sin reportar", async () => {
    const service = grantWith({ hit: "throttled" });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "throttled" });
    expect(service.calls).not.toContain(`firma ${FILE.path}`);
    expect(service.reported).toEqual([]);
  });

  it.each<[string, DownloadHit | "throws"]>([
    ["el freno no se supo", "unavailable"],
    ["el freno se cayó", "throws"],
  ])("%s: falla cerrado, sin firmar", async (_name, hit) => {
    const service = grantWith({ hit });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "unavailable" });
    expect(service.calls).not.toContain(`firma ${FILE.path}`);
    expect(service.reported).toEqual(["resource_grant_unavailable"]);
  });

  it("si no se pudo firmar: «no se supo», reportado", async () => {
    const service = grantWith({ downloadUrl: null });
    expect(await service.getResourceGrant(reader, RESOURCE)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["resource_grant_unavailable"]);
  });
});

describe("bajar lo que subió a su borrador (PA-43)", () => {
  it("el maestro: la guarda, su archivo, el freno y la firma", async () => {
    const service = grantWith();
    expect(await service.getDraftResourceGrant(reader, COURSE, RESOURCE)).toEqual({ kind: "granted", url: DOWNLOAD_URL });
    expect(service.calls).toEqual(["guarda de sesión", `borrador ${COURSE} ${RESOURCE}`, "freno", `firma ${FILE.path}`]);
  });

  it.each<[string, SessionCheck, string]>([
    ["no se supo la sesión", { kind: "unavailable" }, "unavailable"],
    ["cuenta suspendida", { kind: "suspended" }, "suspended"],
    ["sin sesión", { kind: "anonymous" }, "refused"],
  ])("%s: no se lee nada", async (_name, session, kind) => {
    const service = grantWith({ session });
    expect(await service.getDraftResourceGrant(reader, COURSE, RESOURCE)).toEqual({ kind });
    expect(service.calls).toEqual(["guarda de sesión"]);
  });

  it.each([
    ["el curso", "x", RESOURCE],
    ["el recurso", COURSE, "x"],
  ])("%s sin forma: no llega a la base", async (_name, course, resource) => {
    const service = grantWith();
    expect(await service.getDraftResourceGrant(reader, course, resource)).toEqual({ kind: "not_found" });
    expect(service.calls).toEqual(["guarda de sesión"]);
  });

  it("lo que la base no suelta (de otro, o sin confirmar): `not_found`", async () => {
    const service = grantWith({ draftFile: null });
    expect(await service.getDraftResourceGrant(reader, COURSE, RESOURCE)).toEqual({ kind: "not_found" });
    expect(service.calls).not.toContain("freno");
  });

  it("si la base se cayó: «no se supo», reportado", async () => {
    const service = grantWith({ draftFile: "throws" });
    expect(await service.getDraftResourceGrant(reader, COURSE, RESOURCE)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["resource_grant_unavailable"]);
  });

  it("el mismo freno", async () => {
    const service = grantWith({ hit: "throttled" });
    expect(await service.getDraftResourceGrant(reader, COURSE, RESOURCE)).toEqual({ kind: "throttled" });
  });
});
