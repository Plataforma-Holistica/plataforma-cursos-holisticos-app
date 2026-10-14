import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { createResetTokens } from "./reset-token";
import { handoffPrint, type Capability, type CodeGiven, type TeamCheck, type TeamStanding } from "./team";
import {
  createTeamAdmin,
  dictatedCode,
  effectsKey,
  removalEffects,
  resetEffects,
  type TeamInvitation,
  type TeamMember,
  type TeamRoster,
} from "./team-admin";

// Administrar al equipo, con todo lo de fuera simulado: aquí se prueba a quién se le
// pregunta qué, en qué orden, y qué se decide con cada respuesta. Contra la base y el Auth
// de verdad se prueban en `tests/integration/35-equipo-administrar.test.ts`.

const SESSION = "5e000000-0000-4000-8000-000000000001";
const ME = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const THIRD = "c0000000-0000-4000-8000-000000000003";
const INVITATION = "d0000000-0000-4000-8000-000000000004";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: SESSION, issuedAt: 0 } as VerifiedClaims;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const MARK = "m".repeat(22);
const OTHER_MARK = "n".repeat(22);
const tokens = createResetTokens({ secure: () => false, mark: () => MARK });
const CODE = "ABCD-EFGH-JKMN-PQRS";

function jarOf(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (name: string) => values.get(name),
    set(name: string, value: string, options: { maxAge: number }) {
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

/** Un navegador que ya pasó por el primer paso de restablecer a esa persona. */
const armed = (profile = OTHER, session = SESSION, mark = MARK) => jarOf({ "plataforma-restablecer": `${session}.${profile}.${mark}` });

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  profileId: OTHER,
  email: "otra@prueba.test",
  displayName: null,
  status: "active",
  capabilities: ["support"],
  factor: "bound",
  rebind: "none",
  configRemovable: false,
  isSelf: false,
  ...over,
});
const self = (over: Partial<TeamMember> = {}) =>
  member({ profileId: ME, email: "yo@prueba.test", capabilities: ["config"], isSelf: true, ...over });
const invitation = (over: Partial<TeamInvitation> = {}): TeamInvitation => ({
  id: INVITATION,
  kind: "grant",
  email: "invitada@prueba.test",
  profileId: null,
  capabilities: ["support", "content"],
  invitedBy: ME,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  expiresAt: new Date("2026-10-08T00:00:00Z"),
  expired: false,
  acceptable: true,
  ...over,
});
const rosterOf = (members: TeamMember[] = [self(), member()], invitations: TeamInvitation[] = [], freshCode = true): TeamRoster => ({
  freshCode,
  members,
  invitations,
});

const standingOf = (capabilities: string[]): TeamStanding => ({ state: "member", factor: BOUND, capabilities });
const teamCheck = (standing: TeamStanding = standingOf(["config"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

interface Setup {
  /** Lo que contesta la guarda del equipo: una respuesta, o una por cada vez que se le pregunta. */
  check?: TeamCheck | TeamCheck[];
  roster?: TeamRoster | null | "throws";
  answer?: string;
  given?: CodeGiven;
  signOut?: "closed" | "unknown";
  code?: string;
}

function adminWith(setup: Setup = {}) {
  const calls: string[] = [];
  const reported: string[] = [];
  const checks = Array.isArray(setup.check) ? [...setup.check] : null;
  const answered = <Answer>(what: string) => {
    calls.push(what);
    if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
    return Promise.resolve(setup.answer as Answer);
  };
  const auth = {
    signOut: vi.fn(() => {
      calls.push("signOut");
      return Promise.resolve(setup.signOut ?? "closed");
    }),
  };
  const store = {
    roster: vi.fn((asked: VerifiedClaims) => {
      calls.push(`roster ${asked.userId === ME ? "yo" : "otra"}`);
      if (setup.roster === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.roster === undefined ? rosterOf() : setup.roster);
    }),
    invite: vi.fn((_claims: VerifiedClaims, email: string, capabilities: readonly Capability[]) =>
      answered<never>(`invite ${email} ${capabilities.join(",")}`),
    ),
    revokeInvitation: vi.fn((_claims: VerifiedClaims, id: string) => answered<never>(`revokeInvitation ${id}`)),
    grant: vi.fn((_claims: VerifiedClaims, profile: string, capability: Capability) => answered<never>(`grant ${profile} ${capability}`)),
    revoke: vi.fn((_claims: VerifiedClaims, profile: string, capability: Capability) => answered<never>(`revoke ${profile} ${capability}`)),
    resetFactor: vi.fn((_claims: VerifiedClaims, profile: string, handoff: string) => answered<never>(`reset ${profile} ${handoff}`)),
  };
  const teamStanding = vi.fn(() => {
    calls.push("guarda");
    if (checks) return Promise.resolve(checks.length > 1 ? (checks.shift() as TeamCheck) : (checks[0] as TeamCheck));
    return Promise.resolve((setup.check as TeamCheck | undefined) ?? teamCheck());
  });
  const giveSecondFactorCode = vi.fn((_jar: unknown, code: string) => {
    calls.push(`codigo ${code}`);
    return Promise.resolve(setup.given ?? ({ kind: "verified" } as CodeGiven));
  });
  const admin = createTeamAdmin(
    {
      auth: auth as never,
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { teamStanding, giveSecondFactorCode, store, tokens, dictate: () => setup.code ?? CODE },
  );
  return { ...admin, calls, reported, auth, store, teamStanding };
}

/** Los nueve servicios que llegan de una acción, con algo que tenga forma. */
const ENTRIES: [string, (admin: ReturnType<typeof adminWith>, jar: ReturnType<typeof jarOf>) => Promise<{ kind: string }>][] = [
  ["invitar", (admin, jar) => admin.inviteAdmin(jar, { email: "ana@prueba.test", capabilities: ["support"] })],
  ["invitar de nuevo", (admin, jar) => admin.reinviteAdmin(jar, { id: INVITATION })],
  ["revocar una invitación", (admin, jar) => admin.revokeInvitation(jar, { id: INVITATION })],
  ["dar una capacidad", (admin, jar) => admin.grantCapability(jar, { profile: OTHER, capability: "content" })],
  ["quitar una capacidad", (admin, jar) => admin.revokeCapability(jar, { profile: OTHER, capability: "support", confirmed: "last" })],
  ["preparar un restablecimiento", (admin, jar) => admin.prepareReset(jar, { profile: OTHER })],
  ["restablecer", (admin, jar) => admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: MARK })],
  ["dar el código otra vez", (admin, jar) => admin.giveFreshCode(jar, "123456")],
];

const NOT_ADMITTED: [string, TeamCheck][] = [
  ["sin sesión", { kind: "anonymous" }],
  ["una cuenta suspendida", { kind: "suspended" }],
  ["una sesión que ya no vale", { kind: "must_sign_out", then: "sign_in" }],
  ["una cuenta a la que le falta algo", { kind: "incomplete", claims, variant: "complete_account", missing: { name: true, adultDeclaration: false, documents: [] } }],
  ["una cuenta común", teamCheck({ state: "none" })],
  ["una invitada", teamCheck({ state: "invited", kind: "grant", capabilities: ["config"] })],
  ["una invitada sin probar su buzón", teamCheck({ state: "invited_unproven", kind: "grant" })],
  ["alguien sin atadura", teamCheck({ state: "unbound" })],
  ["alguien a quien se le venció el código", teamCheck({ state: "needs_code", factor: BOUND })],
  ["alguien del equipo sin configuración", teamCheck(standingOf(["support", "content", "finance", "moderation"]))],
];

describe("la guarda va primero en todo lo que llega de una acción", () => {
  describe.each(ENTRIES)("%s", (_name, call) => {
    it.each(NOT_ADMITTED)("a %s no se le pregunta nada más a la base, y no se le dice «prohibido»", async (_who, check) => {
      const admin = adminWith({ check });
      const jar = armed();
      expect(await call(admin, jar)).toEqual({ kind: "refused" });
      expect(admin.calls).toEqual(["guarda"]);
      expect(admin.reported).toEqual([]);
      // El testigo sigue donde estaba: no se gastó ni se escribió otro.
      expect([...jar.values]).toEqual([["plataforma-restablecer", `${SESSION}.${OTHER}.${MARK}`]]);
    });

    it("si no se supo quién pide, no se intenta nada: la guarda ya lo reportó", async () => {
      const admin = adminWith({ check: { kind: "unavailable" } });
      expect(await call(admin, armed())).toEqual({ kind: "unavailable" });
      expect(admin.calls).toEqual(["guarda"]);
      expect(admin.reported).toEqual([]);
    });
  });
});

describe("el código que se dicta", () => {
  it("son dieciséis caracteres en cuatro grupos de cuatro", () => {
    expect(dictatedCode()).toMatch(/^[2-9A-HJKMNP-Z]{4}(?:-[2-9A-HJKMNP-Z]{4}){3}$/);
  });

  it("cada carácter se sortea por separado, entre los 31 que no se confunden al dictar", () => {
    const pick = vi.fn((max: number) => max - 1);
    expect(dictatedCode(pick)).toBe("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
    expect(pick.mock.calls).toEqual(Array.from({ length: 16 }, () => [31]));
    let next = 0;
    const all = Array.from({ length: 2 }, () => dictatedCode(() => next++ % 31)).join("");
    expect([...new Set(all.replace(/-/g, ""))].sort().join("")).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    expect(dictatedCode(() => 0)).toBe("2222-2222-2222-2222");
  });

  it("dos seguidos no son el mismo", () => {
    expect(dictatedCode()).not.toBe(dictatedCode());
  });

  it("tiene la forma que aceptar comprobará, se teclee con guiones o sin ellos", () => {
    const code = dictatedCode();
    expect(handoffPrint(code)).toBe(sha256(code.replace(/-/g, "")));
    expect(handoffPrint(code.toLowerCase().replace(/-/g, " "))).toBe(handoffPrint(code));
  });

  // La emergencia no pasa por la aplicación: quien opera la base saca el código y su huella
  // de un guion, que no puede importar este archivo. Si aquí cambia la forma del código o
  // cómo se le saca la huella, el guion tiene que cambiar igual, y esto es lo que avisa.
  it("el guion de la emergencia imprime un código con esa misma forma y la huella que aceptar calculará", () => {
    const printed = execFileSync(process.execPath, ["scripts/team-handoff.mjs"], { encoding: "utf8" });
    const code = /^Código para dictar: (\S+)$/m.exec(printed)?.[1] ?? "";
    const print = /^Huella para la sentencia: (\S+)$/m.exec(printed)?.[1] ?? "";
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}(?:-[2-9A-HJKMNP-Z]{4}){3}$/);
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    expect(print).toBe(handoffPrint(code));
    // El código sale una vez, y la huella no es el código.
    expect(printed.split(code)).toHaveLength(2);
  });
});

describe("qué más pasa al quitar una capacidad", () => {
  it.each<[string, TeamRoster, string, Capability, string[] | null]>([
    ["a otra persona, una de varias", rosterOf([self(), member({ capabilities: ["support", "content"] })]), OTHER, "support", []],
    ["su última", rosterOf(), OTHER, "support", ["last"]],
    ["a una misma, una de varias", rosterOf([self({ capabilities: ["support", "config"] })]), ME, "support", ["self"]],
    ["a una misma, la última", rosterOf([self()]), ME, "config", ["self", "last"]],
    [
      "configuración, con invitaciones hechas por ella",
      rosterOf([self(), member({ capabilities: ["support", "config"] })], [invitation({ invitedBy: OTHER })]),
      OTHER,
      "config",
      ["inviter"],
    ],
    [
      "otra capacidad, aunque haya invitado",
      rosterOf([self(), member({ capabilities: ["support", "config"] })], [invitation({ invitedBy: OTHER })]),
      OTHER,
      "support",
      [],
    ],
    ["configuración, y las invitaciones son de otra", rosterOf([self(), member({ capabilities: ["config"] })], [invitation()]), OTHER, "config", ["last"]],
    ["todo junto", rosterOf([self()], [invitation()]), ME, "config", ["self", "last", "inviter"]],
    ["una capacidad que no tiene", rosterOf(), OTHER, "content", null],
    ["alguien que no está en la lista", rosterOf(), THIRD, "support", null],
  ])("%s", (_what, roster, profile, capability, effects) => {
    expect(removalEffects(roster, profile, capability)).toEqual(effects);
  });
});

describe("qué más pasa al restablecer a alguien", () => {
  const config = (over: Partial<TeamMember> = {}) => member({ capabilities: ["config"], ...over });
  const third = (over: Partial<TeamMember> = {}) => member({ profileId: THIRD, email: "tercera@prueba.test", capabilities: ["config"], ...over });

  it.each<[string, TeamRoster, string, string[] | null]>([
    ["alguien sin configuración", rosterOf(), OTHER, []],
    ["la única otra con configuración", rosterOf([self(), config()]), OTHER, ["alone"]],
    ["una de dos con configuración", rosterOf([self(), config(), third()]), OTHER, []],
    ["cuando la tercera está suspendida", rosterOf([self(), config(), third({ status: "suspended" })]), OTHER, ["alone"]],
    ["cuando la tercera no tiene su factor atado", rosterOf([self(), config(), third({ factor: "none" })]), OTHER, ["alone"]],
    ["cuando Auth perdió el factor de la tercera", rosterOf([self(), config(), third({ factor: "lost" })]), OTHER, ["alone"]],
    ["cuando la tercera no tiene configuración", rosterOf([self(), config(), third({ capabilities: ["support"] })]), OTHER, ["alone"]],
    ["alguien que invitó", rosterOf([self(), member()], [invitation({ invitedBy: OTHER })]), OTHER, ["inviter"]],
    ["alguien que ya estaba restablecida", rosterOf([self(), member({ factor: "none", rebind: "pending" })]), OTHER, ["again"]],
    ["alguien cuyo factor Auth perdió", rosterOf([self(), member({ factor: "lost" })]), OTHER, []],
    // Con configuración pero ya sin atadura: quien actúa ya era la única. Restablecerla otra
    // vez no cambia eso, y no se dice.
    ["la única otra con configuración, que ya estaba restablecida", rosterOf([self(), config({ factor: "none" })]), OTHER, ["again"]],
    ["la única otra con configuración, cuyo factor Auth perdió", rosterOf([self(), config({ factor: "lost" })]), OTHER, []],
    ["la única otra que puede, y además invitó", rosterOf([self(), config()], [invitation({ invitedBy: OTHER })]), OTHER, ["alone", "inviter"]],
    [
      "alguien que invitó y ya estaba restablecida",
      rosterOf([self(), config({ factor: "none" })], [invitation({ invitedBy: OTHER })]),
      OTHER,
      ["inviter", "again"],
    ],
    ["una misma", rosterOf(), ME, null],
    ["una cuenta suspendida", rosterOf([self(), member({ status: "suspended" })]), OTHER, null],
    ["una cuenta en otro estado", rosterOf([self(), member({ status: "other" })]), OTHER, null],
    ["alguien que no está en la lista", rosterOf(), THIRD, null],
  ])("%s", (_what, roster, profile, effects) => {
    expect(resetEffects(roster, profile)).toEqual(effects);
  });

  it("los efectos viajan como un texto que se compara entero", () => {
    expect(effectsKey([])).toBe("");
    expect(effectsKey(["self", "last"])).toBe("self+last");
  });
});

describe("la lista del equipo", () => {
  it("se lee con las claims que la guarda de la página ya dio, sin volver a preguntarle", async () => {
    const admin = adminWith();
    expect(await admin.teamRoster(jarOf(), claims)).toEqual({ kind: "roster", roster: rosterOf() });
    expect(admin.calls).toEqual(["roster yo"]);
  });

  it.each<[string, TeamRoster | null]>([
    ["nula", null],
    ["sin la fila de quien pregunta", rosterOf([member()])],
    ["con otra marcada como quien pregunta", rosterOf([member({ isSelf: true })])],
    ["con su fila sin marcar como suya", rosterOf([self({ isSelf: false }), member()])],
  ])("%s no vale: se le vuelve a preguntar a la guarda, y si ya no pasa no es una caída", async (_what, roster) => {
    const admin = adminWith({ roster, check: teamCheck({ state: "needs_code", factor: BOUND }) });
    expect(await admin.teamRoster(jarOf(), claims)).toEqual({ kind: "unavailable" });
    expect(admin.calls).toEqual(["roster yo", "guarda"]);
    expect(admin.reported).toEqual([]);
  });

  it.each<[string, TeamCheck]>([
    ["no se supo", { kind: "unavailable" }],
    ["ya no tiene sesión", { kind: "anonymous" }],
    ["ya no tiene configuración", teamCheck(standingOf(["support"]))],
  ])("tampoco se reporta si la guarda contesta que %s", async (_what, check) => {
    const admin = adminWith({ roster: null, check });
    expect(await admin.teamRoster(jarOf(), claims)).toEqual({ kind: "unavailable" });
    expect(admin.reported).toEqual([]);
  });

  it("si la guarda insiste en que pasa, alguien tiene que saberlo", async () => {
    const admin = adminWith({ roster: null });
    expect(await admin.teamRoster(jarOf(), claims)).toEqual({ kind: "unavailable" });
    expect(admin.reported).toEqual(["team_roster_unavailable"]);
  });

  it("si la base no contesta, se reporta sin preguntarle a nadie más", async () => {
    const admin = adminWith({ roster: "throws" });
    expect(await admin.teamRoster(jarOf(), claims)).toEqual({ kind: "unavailable" });
    expect(admin.calls).toEqual(["roster yo"]);
    expect(admin.reported).toEqual(["team_roster_unavailable"]);
  });
});

describe("invitar", () => {
  it("manda el correo normalizado y las capacidades sin repetir y en su orden", async () => {
    const admin = adminWith({ answer: "invited_new" });
    const result = await admin.inviteAdmin(jarOf(), { email: "  Ana@Prueba.TEST ", capabilities: ["config", "content", "config"] });
    expect(result).toEqual({ kind: "answered", answer: "invited_new" });
    expect(admin.calls).toEqual(["guarda", "invite ana@prueba.test content,config"]);
    expect(admin.store.invite.mock.calls[0]?.[0]).toBe(claims);
  });

  it.each<[string, unknown, string]>([
    ["vacío", "", "empty"],
    ["que no es texto", ["ana@prueba.test"], "empty"],
    ["ausente", undefined, "empty"],
    ["sin forma", "ana.prueba.test", "malformed"],
    ["desmedido", `${"a".repeat(250)}@prueba.test`, "too_long"],
  ])("un correo %s no llega a la base", async (_what, email, reason) => {
    const admin = adminWith({ answer: "invited_new" });
    expect(await admin.inviteAdmin(jarOf(), { email, capabilities: ["support"] })).toEqual({
      kind: "malformed",
      email: reason,
      capabilities: false,
    });
    expect(admin.calls).toEqual(["guarda"]);
  });

  it.each<[string, unknown]>([
    ["vacía", []],
    ["ausente", undefined],
    ["que no es lista", "support"],
    ["con una que no existe", ["support", "owner"]],
    ["con algo que no es texto", ["support", null]],
    ["desmedida", Array.from({ length: 11 }, () => "support")],
  ])("una lista de capacidades %s tampoco", async (_what, capabilities) => {
    const admin = adminWith({ answer: "invited_new" });
    expect(await admin.inviteAdmin(jarOf(), { email: "ana@prueba.test", capabilities })).toEqual({
      kind: "malformed",
      email: null,
      capabilities: true,
    });
    expect(admin.calls).toEqual(["guarda"]);
  });

  it("con las dos cosas mal, se dicen las dos", async () => {
    const admin = adminWith();
    expect(await admin.inviteAdmin(jarOf(), { email: "x", capabilities: [] })).toEqual({ kind: "malformed", email: "malformed", capabilities: true });
  });

  it.each(["forbidden", "needs_fresh_code", "invalid", "unavailable", "ineligible", "already_member", "already_invited", "invited_new", "invited_existing"])(
    "lo que la base contesta (%s) sale tal cual",
    async (answer) => {
      const admin = adminWith({ answer });
      expect(await admin.inviteAdmin(jarOf(), { email: "ana@prueba.test", capabilities: ["support"] })).toEqual({ kind: "answered", answer });
      expect(admin.reported).toEqual([]);
    },
  );

  it("si la base no contesta algo de su lista, no se supo: se reporta y no se pinta como hecho", async () => {
    const admin = adminWith({ answer: "throws" });
    expect(await admin.inviteAdmin(jarOf(), { email: "ana@prueba.test", capabilities: ["support"] })).toEqual({ kind: "unknown" });
    expect(admin.reported).toEqual(["team_change_unavailable"]);
  });

  it("no manda ningún correo ni toca la sesión", async () => {
    const admin = adminWith({ answer: "invited_new" });
    await admin.inviteAdmin(jarOf(), { email: "ana@prueba.test", capabilities: ["support"] });
    expect(admin.auth.signOut).not.toHaveBeenCalled();
    // El Auth de mentira no tiene con qué pedir un correo: si el servicio lo intentara, lanzaría.
    expect(Object.keys(admin.auth)).toEqual(["signOut"]);
  });
});

describe("invitar de nuevo", () => {
  const expired = invitation({ expired: true, acceptable: false });

  it("a quién y con qué sale de lo que la base tiene de esa invitación, no de lo que llega", async () => {
    const admin = adminWith({ roster: rosterOf(undefined, [expired]), answer: "invited_existing" });
    const input = { id: INVITATION, email: "otra@prueba.test", capabilities: ["config"] };
    expect(await admin.reinviteAdmin(jarOf(), input)).toEqual({ kind: "answered", answer: "invited_existing" });
    expect(admin.calls).toEqual(["guarda", "roster yo", "invite invitada@prueba.test support,content"]);
  });

  it.each<[string, TeamInvitation[]]>([
    ["ya no está en la lista", []],
    ["es otra", [invitation({ id: THIRD, expired: true })]],
    ["no ha caducado", [invitation()]],
    ["es de restablecimiento", [invitation({ kind: "rebind", capabilities: [], expired: true })]],
  ])("si %s, no se invita", async (_what, invitations) => {
    const admin = adminWith({ roster: rosterOf(undefined, invitations), answer: "invited_new" });
    expect(await admin.reinviteAdmin(jarOf(), { id: INVITATION })).toEqual({ kind: "gone" });
    expect(admin.calls).toEqual(["guarda", "roster yo"]);
  });

  it.each([undefined, "", "no-es-un-id", INVITATION.toUpperCase(), [INVITATION], 7])("un identificador sin forma (%j) no llega a la base", async (id) => {
    const admin = adminWith();
    expect(await admin.reinviteAdmin(jarOf(), { id })).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual(["guarda"]);
  });

  it("si la lista no se pudo leer, no se supo quién era: se reporta", async () => {
    const admin = adminWith({ roster: "throws" });
    expect(await admin.reinviteAdmin(jarOf(), { id: INVITATION })).toEqual({ kind: "unavailable" });
    expect(admin.reported).toEqual(["team_roster_unavailable"]);
  });

  it("si la lista llega nula, dejó de pasar la puerta: decide la página", async () => {
    const admin = adminWith({ roster: null });
    expect(await admin.reinviteAdmin(jarOf(), { id: INVITATION })).toEqual({ kind: "refused" });
    expect(admin.reported).toEqual([]);
  });

  it("si invitar no contesta, no se supo", async () => {
    const admin = adminWith({ roster: rosterOf(undefined, [expired]), answer: "throws" });
    expect(await admin.reinviteAdmin(jarOf(), { id: INVITATION })).toEqual({ kind: "unknown" });
    expect(admin.reported).toEqual(["team_change_unavailable"]);
  });
});

describe("revocar una invitación", () => {
  it.each(["forbidden", "needs_fresh_code", "not_found", "revoked"])("lo que la base contesta (%s) sale tal cual", async (answer) => {
    const admin = adminWith({ answer });
    expect(await admin.revokeInvitation(jarOf(), { id: INVITATION })).toEqual({ kind: "answered", answer });
    expect(admin.calls).toEqual(["guarda", `revokeInvitation ${INVITATION}`]);
    expect(admin.store.revokeInvitation.mock.calls[0]?.[0]).toBe(claims);
  });

  it.each([undefined, "", "no-es-un-id", INVITATION.toUpperCase(), `${INVITATION} `, { id: INVITATION }])(
    "un identificador sin forma (%j) no llega a la base",
    async (id) => {
      const admin = adminWith({ answer: "revoked" });
      expect(await admin.revokeInvitation(jarOf(), { id })).toEqual({ kind: "malformed" });
      expect(admin.calls).toEqual(["guarda"]);
    },
  );

  it("si la base no contesta, no se supo", async () => {
    const admin = adminWith({ answer: "throws" });
    expect(await admin.revokeInvitation(jarOf(), { id: INVITATION })).toEqual({ kind: "unknown" });
    expect(admin.reported).toEqual(["team_change_unavailable"]);
  });
});

describe("dar una capacidad", () => {
  it.each(["forbidden", "needs_fresh_code", "invalid", "ineligible", "not_member", "already_has", "granted"])(
    "lo que la base contesta (%s) sale tal cual",
    async (answer) => {
      const admin = adminWith({ answer });
      expect(await admin.grantCapability(jarOf(), { profile: OTHER, capability: "finance" })).toEqual({ kind: "answered", answer });
      expect(admin.calls).toEqual(["guarda", `grant ${OTHER} finance`]);
      expect(admin.store.grant.mock.calls[0]?.[0]).toBe(claims);
    },
  );

  it.each<[string, unknown, unknown]>([
    ["sin persona", undefined, "finance"],
    ["con una persona sin forma", "ana", "finance"],
    ["con una persona en mayúsculas", OTHER.toUpperCase(), "finance"],
    ["sin capacidad", OTHER, undefined],
    ["con una capacidad que no existe", OTHER, "owner"],
    ["con una capacidad que no es texto", OTHER, ["finance"]],
  ])("%s no llega a la base", async (_what, profile, capability) => {
    const admin = adminWith({ answer: "granted" });
    expect(await admin.grantCapability(jarOf(), { profile, capability })).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual(["guarda"]);
  });

  it("si la base no contesta, no se supo", async () => {
    const admin = adminWith({ answer: "throws" });
    expect(await admin.grantCapability(jarOf(), { profile: OTHER, capability: "finance" })).toEqual({ kind: "unknown" });
    expect(admin.reported).toEqual(["team_change_unavailable"]);
  });
});

describe("quitar una capacidad", () => {
  it("con lo que se confirmó todavía cierto, se quita", async () => {
    const admin = adminWith({ answer: "revoked" });
    expect(await admin.revokeCapability(jarOf(), { profile: OTHER, capability: "support", confirmed: "last" })).toEqual({
      kind: "answered",
      answer: "revoked",
    });
    expect(admin.calls).toEqual(["guarda", "roster yo", `revoke ${OTHER} support`]);
    expect(admin.store.revoke.mock.calls[0]?.[0]).toBe(claims);
    // A otra persona: la sesión de quien actúa no se toca.
    expect(admin.auth.signOut).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["otra cosa", ""],
    ["de más", "self+last"],
    ["nada", undefined],
    ["algo que no es texto", ["last"]],
  ])("si lo que se confirmó ya no es lo que pasaría (%s), no se quita: se confirma otra vez", async (_what, confirmed) => {
    const admin = adminWith({ answer: "revoked" });
    expect(await admin.revokeCapability(jarOf(), { profile: OTHER, capability: "support", confirmed })).toEqual({ kind: "changed" });
    expect(admin.calls).toEqual(["guarda", "roster yo"]);
  });

  it.each<[string, string, string]>([
    ["la persona ya no está en la lista", THIRD, "support"],
    ["ya no tiene esa capacidad", OTHER, "content"],
  ])("si %s, tampoco", async (_what, profile, capability) => {
    const admin = adminWith({ answer: "revoked" });
    expect(await admin.revokeCapability(jarOf(), { profile, capability, confirmed: "" })).toEqual({ kind: "changed" });
    expect(admin.calls).toEqual(["guarda", "roster yo"]);
  });

  it.each(["forbidden", "needs_fresh_code", "not_found", "min_config"])("un no de la base (%s) sale tal cual", async (answer) => {
    const admin = adminWith({ answer, roster: rosterOf([self()]) });
    expect(await admin.revokeCapability(jarOf(), { profile: ME, capability: "config", confirmed: "self+last" })).toEqual({ kind: "answered", answer });
    // Aunque fuera a sí misma: no se quitó, y su sesión sigue.
    expect(admin.auth.signOut).not.toHaveBeenCalled();
  });

  it("quien se la quita a sí misma queda sin sesión: la base la cerró, y aquí se borra su cookie", async () => {
    const admin = adminWith({ answer: "revoked", roster: rosterOf([self({ capabilities: ["support", "config"] }), member()]) });
    expect(await admin.revokeCapability(jarOf(), { profile: ME, capability: "support", confirmed: "self" })).toEqual({ kind: "revoked_self" });
    expect(admin.calls).toEqual(["guarda", "roster yo", `revoke ${ME} support`, "signOut"]);
    expect(admin.reported).toEqual([]);
  });

  it("si Auth no contesta al cerrarla, queda dicho, y se contesta igual", async () => {
    const admin = adminWith({ answer: "revoked", roster: rosterOf([self()]), signOut: "unknown" });
    expect(await admin.revokeCapability(jarOf(), { profile: ME, capability: "config", confirmed: "self+last" })).toEqual({ kind: "revoked_self" });
    expect(admin.reported).toEqual(["session_not_closed"]);
  });

  it.each<[string, unknown, unknown]>([
    ["sin persona", undefined, "support"],
    ["con una persona sin forma", "ana", "support"],
    ["con una persona en mayúsculas", OTHER.toUpperCase(), "support"],
    ["con una capacidad que no existe", OTHER, "owner"],
  ])("%s no llega a la base", async (_what, profile, capability) => {
    const admin = adminWith({ answer: "revoked" });
    expect(await admin.revokeCapability(jarOf(), { profile, capability, confirmed: "last" })).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual(["guarda"]);
  });

  it("si la lista no se pudo leer, no se quita nada", async () => {
    const admin = adminWith({ roster: "throws", answer: "revoked" });
    expect(await admin.revokeCapability(jarOf(), { profile: OTHER, capability: "support", confirmed: "last" })).toEqual({ kind: "unavailable" });
    expect(admin.calls).toEqual(["guarda", "roster yo"]);
    expect(admin.reported).toEqual(["team_roster_unavailable"]);
  });

  it("si la base no contesta al quitar, no se supo, y la sesión no se toca", async () => {
    const admin = adminWith({ answer: "throws", roster: rosterOf([self()]) });
    expect(await admin.revokeCapability(jarOf(), { profile: ME, capability: "config", confirmed: "self+last" })).toEqual({ kind: "unknown" });
    expect(admin.reported).toEqual(["team_change_unavailable"]);
    expect(admin.auth.signOut).not.toHaveBeenCalled();
  });
});

describe("el primer paso de restablecer", () => {
  it("deja el testigo de esa sesión para esa persona, y no le pregunta nada más a la base", async () => {
    const admin = adminWith();
    const jar = jarOf();
    expect(await admin.prepareReset(jar, { profile: OTHER })).toEqual({ kind: "ready", token: MARK });
    expect([...jar.values]).toEqual([["plataforma-restablecer", `${SESSION}.${OTHER}.${MARK}`]]);
    expect(admin.calls).toEqual(["guarda"]);
  });

  it.each([undefined, "", "ana", OTHER.toUpperCase(), [OTHER]])("una persona sin forma (%j) no deja testigo", async (profile) => {
    const admin = adminWith();
    const jar = jarOf();
    expect(await admin.prepareReset(jar, { profile })).toEqual({ kind: "malformed" });
    expect(jar.values.size).toBe(0);
  });

  it("nadie se restablece a sí misma", async () => {
    const admin = adminWith();
    const jar = jarOf();
    expect(await admin.prepareReset(jar, { profile: ME })).toEqual({ kind: "malformed" });
    expect(jar.values.size).toBe(0);
  });

  it("sin dónde dejarlo no hay segundo paso: no se supo", async () => {
    const admin = adminWith({ check: { kind: "team", claims: { ...claims, sessionId: null } as VerifiedClaims, standing: standingOf(["config"]), inProgress: null } });
    expect(await admin.prepareReset(jarOf(), { profile: OTHER })).toEqual({ kind: "unavailable" });
  });
});

describe("restablecer el segundo factor de alguien", () => {
  it("gasta el testigo, manda la huella del código y devuelve el código una vez", async () => {
    const admin = adminWith({ answer: "reset" });
    const jar = armed();
    // El testigo ya no está cuando se llama a la base: un reenvío no llegaría hasta aquí.
    admin.store.resetFactor.mockImplementationOnce((_claims, profile, handoff) => {
      admin.calls.push(`reset ${profile} ${handoff} ${jar.values.size === 0 ? "sin testigo" : "con testigo"}`);
      return Promise.resolve("reset" as never);
    });
    expect(await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: MARK })).toEqual({ kind: "reset", code: CODE });
    expect(admin.calls).toEqual(["guarda", "roster yo", `reset ${OTHER} ${sha256("ABCDEFGHJKMNPQRS")} sin testigo`]);
    expect(admin.store.resetFactor.mock.calls[0]?.[0]).toBe(claims);
    expect(admin.reported).toEqual([]);
  });

  it("la huella que se manda es la que aceptar calculará con lo que la persona teclee", async () => {
    const admin = adminWith({ answer: "reset" });
    await admin.resetSecondFactor(armed(), { profile: OTHER, confirmed: "", token: MARK });
    expect(admin.store.resetFactor.mock.calls[0]?.[2]).toBe(handoffPrint("abcd efgh jkmn pqrs"));
  });

  it("un reenvío ya no trae testigo: no toca nada, y lo dice", async () => {
    const admin = adminWith({ answer: "reset" });
    const jar = armed();
    expect((await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: MARK })).kind).toBe("reset");
    expect(await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: MARK })).toEqual({ kind: "already_sent" });
    expect(admin.store.resetFactor).toHaveBeenCalledOnce();
    expect(admin.calls.slice(-1)).toEqual(["guarda"]);
  });

  it.each<[string, ReturnType<typeof jarOf>]>([
    ["sin testigo", jarOf()],
    ["con el de otra persona", armed(THIRD)],
    ["con el de otra sesión", armed(OTHER, "5e000000-0000-4000-8000-000000000009")],
    ["con el de otra confirmación", armed(OTHER, SESSION, OTHER_MARK)],
  ])("%s, saltarse el primer paso no restablece", async (_what, jar) => {
    const admin = adminWith({ answer: "reset" });
    expect(await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: MARK })).toEqual({ kind: "already_sent" });
    expect(admin.calls).toEqual(["guarda"]);
  });

  it.each([undefined, "", "corta", OTHER_MARK, [MARK], `${MARK} `])("sin la marca de esa confirmación (%j), el testigo no vale", async (token) => {
    const admin = adminWith({ answer: "reset" });
    const jar = armed();
    expect(await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token })).toEqual({ kind: "already_sent" });
    expect(admin.calls).toEqual(["guarda"]);
    // Y no lo gasta: la confirmación de verdad sigue pudiendo enviarse.
    expect(jar.values.size).toBe(1);
  });

  // Volver atrás hasta una confirmación anterior y reenviarla, después de haber pedido otra
  // para la misma persona: su formulario trae la marca de antes, y el testigo es el nuevo.
  it("el formulario de una confirmación anterior no vale para el testigo de la siguiente", async () => {
    const marks = [MARK, OTHER_MARK];
    const admin = createTeamAdmin(
      { auth: { signOut: () => Promise.resolve("closed") } as never, report: () => Promise.resolve() },
      {
        teamStanding: () => Promise.resolve(teamCheck()),
        giveSecondFactorCode: () => Promise.resolve({ kind: "verified" }),
        store: {
          roster: () => Promise.resolve(rosterOf()),
          resetFactor: () => Promise.resolve("reset"),
        } as never,
        tokens: createResetTokens({ secure: () => false, mark: () => marks.shift() ?? "" }),
        dictate: () => CODE,
      },
    );
    const jar = jarOf();
    expect(await admin.prepareReset(jar, { profile: OTHER })).toEqual({ kind: "ready", token: MARK });
    expect(await admin.prepareReset(jar, { profile: OTHER })).toEqual({ kind: "ready", token: OTHER_MARK });
    expect(await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: MARK })).toEqual({ kind: "already_sent" });
    expect((await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: OTHER_MARK })).kind).toBe("reset");
  });

  it.each<[string, TeamRoster, unknown]>([
    ["ahora quedaría como la única con configuración", rosterOf([self(), member({ capabilities: ["config"] })]), ""],
    ["ya no quedaría sola", rosterOf(), "alone"],
    ["la persona ya no está en la lista", rosterOf([self()]), ""],
    ["su cuenta se suspendió", rosterOf([self(), member({ status: "suspended" })]), ""],
    ["no llegó qué se confirmó", rosterOf(), undefined],
  ])("si %s, no se restablece: se confirma otra vez, y el testigo se queda", async (_what, roster, confirmed) => {
    const admin = adminWith({ roster, answer: "reset" });
    const jar = armed();
    expect(await admin.resetSecondFactor(jar, { profile: OTHER, confirmed, token: MARK })).toEqual({ kind: "changed" });
    expect(admin.calls).toEqual(["guarda", "roster yo"]);
    expect(jar.values.size).toBe(1);
  });

  it("con todo lo que pasaría confirmado, restablece", async () => {
    const roster = rosterOf([self(), member({ capabilities: ["config"] })], [invitation({ invitedBy: OTHER })]);
    const admin = adminWith({ roster, answer: "reset" });
    expect((await admin.resetSecondFactor(armed(), { profile: OTHER, confirmed: "alone+inviter", token: MARK })).kind).toBe("reset");
  });

  it.each(["forbidden", "needs_fresh_code", "self", "invalid", "unavailable", "ineligible", "not_member"])(
    "un no de la base (%s) sale tal cual, y sin código",
    async (answer) => {
      const admin = adminWith({ answer });
      const result = await admin.resetSecondFactor(armed(), { profile: OTHER, confirmed: "", token: MARK });
      expect(result).toEqual({ kind: "answered", answer });
      expect(JSON.stringify(result)).not.toContain("ABCD");
    },
  );

  it("si la base no contesta, no se supo: nadie conoce ese código, y no se devuelve", async () => {
    const admin = adminWith({ answer: "throws" });
    const result = await admin.resetSecondFactor(armed(), { profile: OTHER, confirmed: "", token: MARK });
    expect(result).toEqual({ kind: "unknown" });
    expect(admin.reported).toEqual(["team_change_unavailable"]);
  });

  it("si la lista no se pudo leer, no se restablece y el testigo se queda", async () => {
    const admin = adminWith({ roster: "throws", answer: "reset" });
    const jar = armed();
    expect(await admin.resetSecondFactor(jar, { profile: OTHER, confirmed: "", token: MARK })).toEqual({ kind: "unavailable" });
    expect(admin.store.resetFactor).not.toHaveBeenCalled();
    expect(jar.values.size).toBe(1);
  });

  it.each(["", "corto", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456-789A-BCDE", "ABCD/EFGH"])(
    "un código generado sin la forma que aceptar comprobará (%j) no se manda: no se supo",
    async (code) => {
      const admin = adminWith({ code, answer: "reset" });
      expect(await admin.resetSecondFactor(armed(), { profile: OTHER, confirmed: "", token: MARK })).toEqual({ kind: "unknown" });
      expect(admin.store.resetFactor).not.toHaveBeenCalled();
      expect(admin.reported).toEqual(["team_change_unavailable"]);
    },
  );

  it.each([undefined, "", "ana", OTHER.toUpperCase()])("una persona sin forma (%j) no llega a la base", async (profile) => {
    const admin = adminWith({ answer: "reset" });
    expect(await admin.resetSecondFactor(armed(), { profile, confirmed: "", token: MARK })).toEqual({ kind: "malformed" });
    expect(admin.calls).toEqual(["guarda"]);
  });
});

describe("dar el código otra vez para cambiar el equipo", () => {
  it("verificado, y con la lista diciendo que ya es reciente: listo", async () => {
    const admin = adminWith();
    expect(await admin.giveFreshCode(jarOf(), "123 456")).toEqual({ kind: "verified" });
    // El código llega tal cual a quien lo revisa; la sesión se vuelve a leer después de verificar.
    expect(admin.calls).toEqual(["guarda", "codigo 123 456", "guarda", "roster yo"]);
    expect(admin.reported).toEqual([]);
  });

  it.each<[string, TeamRoster | null | "throws"]>([
    ["sigue diciendo que no es reciente", rosterOf(undefined, undefined, false)],
    ["llega nula", null],
    ["no se pudo leer", "throws"],
  ])("verificado, pero la lista %s: pedirlo otra vez no arregla nada, y se reporta", async (_what, roster) => {
    const admin = adminWith({ roster });
    expect(await admin.giveFreshCode(jarOf(), "123456")).toEqual({ kind: "not_available" });
    expect(admin.reported).toEqual(["team_change_unavailable"]);
  });

  it.each<[CodeGiven, { kind: string }]>([
    [{ kind: "wrong_code" }, { kind: "wrong_code" }],
    [{ kind: "throttled" }, { kind: "throttled" }],
    [{ kind: "unavailable" }, { kind: "unavailable" }],
    [{ kind: "not_member" }, { kind: "refused" }],
    [{ kind: "signed_out" }, { kind: "refused" }],
    [{ kind: "anonymous" }, { kind: "refused" }],
    [{ kind: "suspended" }, { kind: "refused" }],
    [{ kind: "must_sign_out", then: "sign_in" }, { kind: "refused" }],
  ])("lo que contesta dar el código (%j) no lee la lista", async (given, expected) => {
    const admin = adminWith({ given });
    expect(await admin.giveFreshCode(jarOf(), "123456")).toEqual(expected);
    expect(admin.calls).toEqual(["guarda", "codigo 123456"]);
    expect(admin.reported).toEqual([]);
  });

  it.each<[string, TeamCheck, { kind: string }]>([
    ["ya no tiene configuración", teamCheck(standingOf(["support"])), { kind: "refused" }],
    ["no se supo", { kind: "unavailable" }, { kind: "unavailable" }],
  ])("verificado, si después la guarda dice que %s, decide ella", async (_what, after, expected) => {
    const admin = adminWith({ check: [teamCheck(), after] });
    expect(await admin.giveFreshCode(jarOf(), "123456")).toEqual(expected);
    expect(admin.calls).toEqual(["guarda", "codigo 123456", "guarda"]);
    expect(admin.reported).toEqual([]);
  });
});
