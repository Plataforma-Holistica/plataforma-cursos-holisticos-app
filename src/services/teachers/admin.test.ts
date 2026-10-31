import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, CodeGiven, TeamCheck, TeamStanding } from "@/services/account/team";

import { createTeacherAdmin, founderDayOf, SUSPENSION_NOTICE_MAX, teacherVersion, type TeacherAdminStore, type TeacherRoster, type TeacherRow } from "./admin";

// Administrar a los maestros, con todo lo de fuera simulado: a quién se le pregunta qué, en qué orden, y qué se decide
// con cada respuesta. Contra la base de verdad se prueba en `tests/integration/82-administrar-maestros.test.ts`.

const ME = "a0000000-0000-4000-8000-000000000001";
const TEACHER = "b0000000-0000-4000-8000-000000000002";
const OTHER = "b0000000-0000-4000-8000-000000000003";
const REQUEST = "c0000000-0000-4000-8000-000000000004";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const jar = { get: () => undefined, set: () => undefined };

const ROW: TeacherRow = {
  id: TEACHER,
  name: "Ana",
  status: "active",
  founderSince: null,
  email: "ana@prueba.test",
  invitation: "accepted",
  expiresAt: null,
  suspension: null,
  suspendedAt: null,
  suspensionReason: null,
  suspensionNotice: null,
  fraudPending: false,
  isSelf: false,
};
const ROSTER: TeacherRoster = {
  freshCode: true,
  teachers: [ROW],
  requests: [
    {
      id: REQUEST,
      teacherId: TEACHER,
      name: "Ana",
      reason: "Puntos inflados",
      proposedAt: "2026-10-30T00:00:00Z",
      proposedBySelf: false,
      markedBySelf: false,
      aboutSelf: false,
      period: 202610,
      metric: 500,
      threshold: 300,
    },
  ],
};
const SEEN = teacherVersion(ROW);

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND });
const teamCheck = (capabilities: Capability[] = ["content"]): TeamCheck => ({ kind: "team", claims, standing: standingOf(capabilities), inProgress: null });

function adminWith(setup: { check?: TeamCheck; roster?: TeacherRoster | null | "throws"; answer?: string | "throws"; given?: CodeGiven } = {}) {
  const calls: string[] = [];
  const reported: string[] = [];
  const answered = (label: string) => {
    calls.push(label);
    if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
    return Promise.resolve(setup.answer ?? "ok");
  };
  const store = {
    roster: vi.fn(() => {
      calls.push("roster");
      if (setup.roster === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.roster === undefined ? ROSTER : setup.roster);
    }),
    invite: vi.fn((_: VerifiedClaims, name: string, email: string) => answered(`invite ${name} ${email}`)),
    reinvite: vi.fn((_: VerifiedClaims, teacher: string) => answered(`reinvite ${teacher}`)),
    revoke: vi.fn((_: VerifiedClaims, teacher: string) => answered(`revoke ${teacher}`)),
    setFounder: vi.fn((_: VerifiedClaims, teacher: string, since: string | null) => answered(`founder ${teacher} ${since}`)),
    suspend: vi.fn((_: VerifiedClaims, teacher: string, reason: string, notice: string) => answered(`suspend ${teacher} ${reason} ${notice}`)),
    lift: vi.fn((_: VerifiedClaims, teacher: string) => answered(`lift ${teacher}`)),
    decide: vi.fn((_: VerifiedClaims, request: string, confirm: boolean, note: string | null, notice: string | null) =>
      answered(`decide ${request} ${confirm} ${note} ${notice}`),
    ),
  };
  const teamStanding = vi.fn((): Promise<TeamCheck> => Promise.resolve(setup.check ?? teamCheck()));
  const service = createTeacherAdmin(
    {
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    {
      teamStanding,
      giveSecondFactorCode: vi.fn((): Promise<CodeGiven> => Promise.resolve(setup.given ?? { kind: "verified" })),
      store: store as unknown as TeacherAdminStore,
    },
  );
  return { ...service, calls, reported, store, teamStanding };
}

const SIGNED_OUT: TeamCheck = { kind: "anonymous" };

describe("la guarda va primero", () => {
  const changes: [string, (admin: ReturnType<typeof adminWith>) => Promise<{ kind: string }>][] = [
    ["invitar", (admin) => admin.inviteTeacher(jar, { name: "Ana", email: "ana@prueba.test" })],
    ["reenviar", (admin) => admin.reinviteTeacher(jar, { teacher: TEACHER, seen: SEEN })],
    ["revocar", (admin) => admin.revokeTeacherInvitation(jar, { teacher: TEACHER, seen: SEEN })],
    ["fundador", (admin) => admin.setTeacherFounder(jar, { teacher: TEACHER, seen: SEEN, since: "2026-11-01" })],
    ["fundador sin forma", (admin) => admin.setTeacherFounder(jar, { teacher: TEACHER, seen: SEEN, since: "mañana" })],
    ["suspender", (admin) => admin.suspendTeacher(jar, { teacher: TEACHER, seen: SEEN, reason: "r", notice: "n" })],
    ["suspender sin forma", (admin) => admin.suspendTeacher(jar, { teacher: TEACHER, seen: SEEN, reason: "", notice: "" })],
    ["levantar", (admin) => admin.liftTeacherSuspension(jar, { teacher: TEACHER, seen: SEEN })],
    ["decidir", (admin) => admin.decideTeacherFraud(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: true, note: null, notice: "n" })],
    ["decidir sin forma", (admin) => admin.decideTeacherFraud(jar, { teacher: TEACHER, seen: SEEN, request: "x", confirm: true, note: null, notice: "n" })],
  ];

  it.each(changes)("%s: sin sesión contesta `refused` y no le pregunta nada a la base", async (_name, run) => {
    const admin = adminWith({ check: SIGNED_OUT });
    expect(await run(admin)).toEqual({ kind: "refused" });
    expect(admin.calls).toEqual([]);
  });

  it.each(changes)("%s: sin Contenido contesta `refused`, aunque tenga otras capacidades", async (_name, run) => {
    const admin = adminWith({ check: teamCheck(["finance", "config"]) });
    expect(await run(admin)).toEqual({ kind: "refused" });
    expect(admin.calls).toEqual([]);
  });

  it.each(changes)("%s: si no se supo quién pide, `unavailable`", async (_name, run) => {
    const admin = adminWith({ check: { kind: "unavailable" } });
    expect(await run(admin)).toEqual({ kind: "unavailable" });
    expect(admin.calls).toEqual([]);
  });
});

describe("lo que no tiene forma no llega a la base", () => {
  it.each([
    [{ name: "", email: "ana@prueba.test" }],
    [{ name: "  ", email: "ana@prueba.test" }],
    [{ name: "x".repeat(81), email: "ana@prueba.test" }],
    [{ name: "Ana", email: "sin-arroba" }],
    [{ name: 3, email: "ana@prueba.test" }],
    [{ name: "Ana", email: null }],
  ])("invitar con %j", async (input) => {
    const admin = adminWith();
    expect(await admin.inviteTeacher(jar, input)).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual([]);
  });

  it("invitar limpia el nombre y deja el correo como lo entiende el dominio", async () => {
    const admin = adminWith({ answer: "invited_new" });
    expect(await admin.inviteTeacher(jar, { name: "  Ana  ", email: " ANA@Prueba.test " })).toEqual({ kind: "answered", answer: "invited_new" });
    expect(admin.calls).toEqual(["invite Ana ana@prueba.test"]);
  });

  it.each([
    [{ teacher: "no-es-un-id", seen: SEEN }],
    [{ teacher: TEACHER.toUpperCase(), seen: SEEN }],
    [{ teacher: TEACHER, seen: 3 }],
  ])("un maestro sin forma: %j", async (input) => {
    const admin = adminWith();
    expect(await admin.reinviteTeacher(jar, input)).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual([]);
  });

  it.each(["2026-02-30", "26-1-1", "", 20261101, undefined])("un día que no es del calendario: %s", async (since) => {
    const admin = adminWith();
    expect(await admin.setTeacherFounder(jar, { teacher: TEACHER, seen: SEEN, since })).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual([]);
  });

  it.each([
    [{ reason: "", notice: "n" }],
    [{ reason: "r", notice: "   " }],
    [{ reason: "r".repeat(1_001), notice: "n" }],
    [{ reason: "r", notice: "n".repeat(SUSPENSION_NOTICE_MAX + 1) }],
  ])("suspender con %j", async (input) => {
    const admin = adminWith();
    expect(await admin.suspendTeacher(jar, { teacher: TEACHER, seen: SEEN, ...input })).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual([]);
  });

  it("confirmar un fraude sin el texto para el maestro no llega", async () => {
    const admin = adminWith();
    expect(await admin.decideTeacherFraud(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: true, note: null, notice: " " })).toEqual({
      kind: "malformed",
    });
    expect(admin.calls).toEqual([]);
  });

  it("una nota desmedida al decidir no llega", async () => {
    const admin = adminWith();
    expect(await admin.decideTeacherFraud(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: false, note: "n".repeat(4_001), notice: null })).toEqual({
      kind: "malformed",
    });
    expect(admin.calls).toEqual([]);
  });
});

describe("lo que se vio de un maestro", () => {
  it("cada cosa que cambia qué se le puede hacer cambia lo que se vio", () => {
    const versions = [
      ROW,
      { ...ROW, status: "suspended" as const },
      { ...ROW, founderSince: "2026-11-01" },
      { ...ROW, invitation: "expired" as const },
      { ...ROW, suspension: "fraud" as const },
      { ...ROW, fraudPending: true },
    ].map(teacherVersion);
    expect(new Set(versions).size).toBe(versions.length);
    for (const version of versions) expect(version).not.toContain(":");
  });

  it("si ya no es lo que se vio, contesta `changed` sin hacer nada", async () => {
    const admin = adminWith({ roster: { ...ROSTER, teachers: [{ ...ROW, status: "suspended" }] } });
    expect(await admin.suspendTeacher(jar, { teacher: TEACHER, seen: SEEN, reason: "r", notice: "n" })).toEqual({ kind: "changed" });
    expect(admin.calls).toEqual(["roster"]);
  });

  it("un maestro que ya no está en la lista contesta `changed`", async () => {
    const admin = adminWith({ roster: { ...ROSTER, teachers: [] } });
    expect(await admin.liftTeacherSuspension(jar, { teacher: TEACHER, seen: SEEN })).toEqual({ kind: "changed" });
    expect(admin.calls).toEqual(["roster"]);
  });

  it.each([
    ["nula", null, []],
    ["que falla", "throws" as const, ["teacher_roster_unavailable"]],
  ])("con una lectura %s no se intenta: no se sabe si sigue siendo lo que se vio", async (_name, roster, reported) => {
    const admin = adminWith({ roster });
    expect(await admin.liftTeacherSuspension(jar, { teacher: TEACHER, seen: SEEN })).toEqual({ kind: "unavailable" });
    expect(admin.store.lift).not.toHaveBeenCalled();
    expect(admin.reported).toEqual(reported);
  });

  it("relee primero y cambia después", async () => {
    const admin = adminWith({ answer: "suspended" });
    expect(await admin.suspendTeacher(jar, { teacher: TEACHER, seen: SEEN, reason: " Motivo ", notice: " Aviso " })).toEqual({ kind: "answered", answer: "suspended" });
    expect(admin.calls).toEqual(["roster", `suspend ${TEACHER} Motivo Aviso`]);
  });
});

describe("cada cambio", () => {
  it("fundador con un día, y sin él para quitarlo", async () => {
    const admin = adminWith({ answer: "set" });
    await admin.setTeacherFounder(jar, { teacher: TEACHER, seen: SEEN, since: "2026-11-01" });
    await admin.setTeacherFounder(jar, { teacher: TEACHER, seen: SEEN, since: null });
    expect(admin.calls).toEqual(["roster", `founder ${TEACHER} 2026-11-01`, "roster", `founder ${TEACHER} null`]);
  });

  it("reenviar y revocar solo llevan al maestro", async () => {
    const admin = adminWith({ answer: "revoked" });
    await admin.reinviteTeacher(jar, { teacher: TEACHER, seen: SEEN });
    await admin.revokeTeacherInvitation(jar, { teacher: TEACHER, seen: SEEN });
    expect(admin.calls).toEqual(["roster", `reinvite ${TEACHER}`, "roster", `revoke ${TEACHER}`]);
  });

  it("confirmar lleva el texto para el maestro; rechazar, solo la nota", async () => {
    const admin = adminWith({ answer: "confirmed" });
    await admin.decideTeacherFraud(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: true, note: "", notice: " Aviso " });
    await admin.decideTeacherFraud(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: false, note: " Sin caso ", notice: "se ignora" });
    expect(admin.calls).toEqual(["roster", `decide ${REQUEST} true null Aviso`, "roster", `decide ${REQUEST} false Sin caso null`]);
  });

  it("una propuesta de otro maestro no se decide por este", async () => {
    const admin = adminWith({ roster: { ...ROSTER, requests: [{ ...ROSTER.requests[0]!, teacherId: OTHER }] } });
    expect(await admin.decideTeacherFraud(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: true, note: null, notice: "n" })).toEqual({
      kind: "answered",
      answer: "not_found",
    });
    expect(admin.store.decide).not.toHaveBeenCalled();
  });

  it.each([
    ["invitar", (admin: ReturnType<typeof adminWith>) => admin.inviteTeacher(jar, { name: "Ana", email: "ana@prueba.test" })],
    ["levantar", (admin: ReturnType<typeof adminWith>) => admin.liftTeacherSuspension(jar, { teacher: TEACHER, seen: SEEN })],
  ])("%s: si la base falla, `unknown` y queda dicho: nunca se pinta como hecho", async (_name, run) => {
    const admin = adminWith({ answer: "throws" });
    expect(await run(admin)).toEqual({ kind: "unknown" });
    expect(admin.reported).toEqual(["teacher_change_unavailable"]);
  });
});

describe("leer", () => {
  it("devuelve la lista", async () => {
    expect(await adminWith().teacherRoster(claims)).toEqual({ kind: "roster", roster: ROSTER });
  });

  it("nula es «no se supo», sin reportar: la sesión dejó de pasar", async () => {
    const admin = adminWith({ roster: null });
    expect(await admin.teacherRoster(claims)).toEqual({ kind: "unavailable" });
    expect(admin.reported).toEqual([]);
  });

  it("si falla, «no se supo», y queda dicho", async () => {
    const admin = adminWith({ roster: "throws" });
    expect(await admin.teacherRoster(claims)).toEqual({ kind: "unavailable" });
    expect(admin.reported).toEqual(["teacher_roster_unavailable"]);
  });

  it("no corre la guarda otra vez: ya corrió", async () => {
    const admin = adminWith();
    await admin.teacherRoster(claims);
    expect(admin.teamStanding).not.toHaveBeenCalled();
  });
});

describe("dar el código", () => {
  it("verificado y reciente", async () => {
    expect(await adminWith().giveTeacherCode(jar, "123456")).toEqual({ kind: "verified" });
  });

  it.each(["wrong_code", "throttled", "unavailable"] as const)("%s se contesta tal cual", async (kind) => {
    expect(await adminWith({ given: { kind } as CodeGiven }).giveTeacherCode(jar, "123456")).toEqual({ kind });
  });

  it("verificado y aun así sin código reciente: es configuración, y queda dicho", async () => {
    const admin = adminWith({ roster: { ...ROSTER, freshCode: false } });
    expect(await admin.giveTeacherCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(admin.reported).toEqual(["teacher_change_unavailable"]);
  });

  it("perdió Contenido entre una cosa y otra: decide la página", async () => {
    expect(await adminWith({ roster: null }).giveTeacherCode(jar, "123456")).toEqual({ kind: "refused" });
  });
});

describe("el día del fundador", () => {
  it.each([
    ["2026-11-01", "2026-11-01"],
    ["2028-02-29", "2028-02-29"],
    ["2026-02-29", null],
    ["2026-13-01", null],
    ["2026-11-1", null],
    [" 2026-11-01", null],
  ])("%s: %s", (value, expected) => {
    expect(founderDayOf(value)).toBe(expected);
  });
});
