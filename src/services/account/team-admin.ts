import "server-only";

import { randomInt } from "node:crypto";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { parseEmail } from "@/domain/access/email";

import type { AccountDependencies } from "./deps";
import { CAPABILITIES, handoffPrint, holds, type Capability, type CodeGiven, type TeamCheck } from "./team";

// Administrar al equipo (RF-712, RF-105; TRD §9.2, fila «Invitaciones»): ver a quién se
// administra, invitar, revocar una invitación, dar y quitar una capacidad, y restablecerle
// el segundo factor a alguien.
//
// Quién puede cambiar el equipo lo decide la base, con su propia puerta (configuración y un
// código reciente). Aquí solo se decide a quién se le pregunta qué, y en qué orden:
//
//   · La guarda va primero, siempre. A quien no es del equipo con configuración no se le
//     pregunta nada más a la base, y no se le dice «prohibido»: se contesta `refused`, y la
//     pantalla lo manda a su página, donde decide la guarda de la página. Una acción es una
//     puerta pública, y quien llega puede ser una alumna, una invitada, o alguien a quien se
//     le venció el código con la pantalla abierta.
//   · Lo que llega se revisa antes de tocar la base: lo que no tiene forma no llega.
//   · Nada de lo que llega dice quién actúa: sale de la sesión que pasó la guarda.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra su lista
//     cerrada. Una respuesta que no está en la lista, o una excepción, es «no se supo»: se
//     reporta y nunca se pinta como hecho.

/** Una persona del equipo, como la devuelve `private.team_roster()`. */
export interface TeamMember {
  profileId: string;
  /** El correo que la cuenta tiene hoy. Es su identidad en la pantalla. */
  email: string | null;
  displayName: string | null;
  status: "active" | "suspended" | "other";
  /** Las activas, en el orden de `CAPABILITIES`. */
  capabilities: Capability[];
  /** `lost`: lo tiene atado, pero Auth ya no. `none`: sin atadura. */
  factor: "bound" | "lost" | "none";
  /** Su invitación para volver, si tiene alguna viva. */
  rebind: "none" | "pending" | "expired" | "unusable";
  /** Tiene configuración y quedarían otras dos cuentas activas con ella. */
  configRemovable: boolean;
  isSelf: boolean;
  /**
   * La versión con que se confirma restablecerla (`n.a`: cuántas invitaciones tuvo su cuenta
   * y cuántas aceptó). Cambia con cada restablecimiento y cuando vuelve.
   */
  resetVersion: string;
}

/** Una invitación viva (ni aceptada ni revocada), caducada o no. */
export interface TeamInvitation {
  id: string;
  kind: "grant" | "rebind";
  email: string;
  profileId: string | null;
  /** En el orden en que se pidieron. */
  capabilities: Capability[];
  /** Nulo: la puso el dueño de la base. */
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  expired: boolean;
  /** Aceptar no la revocaría. */
  acceptable: boolean;
}

export interface TeamRoster {
  /** Un cambio al equipo pasaría hoy su puerta sin pedir el código otra vez. */
  freshCode: boolean;
  members: TeamMember[];
  invitations: TeamInvitation[];
}

/** Lo que contesta cada función de la base que cambia el equipo. */
export const INVITE_ANSWERS = [
  "forbidden",
  "needs_fresh_code",
  "invalid",
  "unavailable",
  "ineligible",
  "already_member",
  "already_invited",
  "invited_new",
  "invited_existing",
] as const;
export const REVOKE_INVITATION_ANSWERS = ["forbidden", "needs_fresh_code", "not_found", "revoked"] as const;
export const GRANT_ANSWERS = ["forbidden", "needs_fresh_code", "invalid", "ineligible", "not_member", "already_has", "granted"] as const;
export const REVOKE_ANSWERS = ["forbidden", "needs_fresh_code", "not_found", "min_config", "revoked"] as const;
export const RESET_ANSWERS = [
  "forbidden",
  "needs_fresh_code",
  "self",
  "invalid",
  "unavailable",
  "ineligible",
  "not_member",
  "already_sent",
  "changed",
  "reset",
] as const;
export type InviteAnswer = (typeof INVITE_ANSWERS)[number];
export type RevokeInvitationAnswer = (typeof REVOKE_INVITATION_ANSWERS)[number];
export type GrantAnswer = (typeof GRANT_ANSWERS)[number];
export type RevokeAnswer = (typeof REVOKE_ANSWERS)[number];
export type ResetAnswer = (typeof RESET_ANSWERS)[number];

/**
 * Lo que estos servicios le preguntan a la base, a nombre de las claims que se les pasan.
 * La lista es nula cuando quien actúa no pasa la puerta del equipo con configuración. Cada
 * cambio lanza si la base no contestó algo de su lista: quien llama lo trata como «no se
 * supo».
 */
export interface TeamAdminStore {
  roster(claims: VerifiedClaims): Promise<TeamRoster | null>;
  invite(claims: VerifiedClaims, email: string, capabilities: readonly Capability[]): Promise<InviteAnswer>;
  revokeInvitation(claims: VerifiedClaims, invitationId: string): Promise<RevokeInvitationAnswer>;
  grant(claims: VerifiedClaims, profileId: string, capability: Capability): Promise<GrantAnswer>;
  revoke(claims: VerifiedClaims, profileId: string, capability: Capability): Promise<RevokeAnswer>;
  resetFactor(claims: VerifiedClaims, profileId: string, handoff: string, version: string): Promise<ResetAnswer>;
}

/** La guarda no dejó: lo decide la página, a donde la pantalla manda. */
interface Refused {
  kind: "refused";
}
/** No se supo quién pide. No se intentó nada. */
interface Unavailable {
  kind: "unavailable";
}
/** Se intentó, y no se supo si se hizo: quien lo pidió mira la lista. */
interface Unknown {
  kind: "unknown";
}
/** Lo que llegó no tiene forma: no se le preguntó a la base. */
interface Malformed {
  kind: "malformed";
}
/** Lo que se confirmó ya no es lo que pasaría: se confirma otra vez, con lo de ahora. */
interface Changed {
  kind: "changed";
}

export type RosterRead = { kind: "roster"; roster: TeamRoster } | Unavailable;
export type InviteResult =
  | Refused
  | Unavailable
  | Unknown
  | { kind: "malformed"; email: "empty" | "too_long" | "malformed" | null; capabilities: boolean }
  | { kind: "answered"; answer: InviteAnswer };
export type ReinviteResult = Refused | Unavailable | Unknown | Malformed | { kind: "gone" } | { kind: "answered"; answer: InviteAnswer };
export type InvitationRevoked = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: RevokeInvitationAnswer };
export type CapabilityGranted = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: GrantAnswer };
export type CapabilityRevoked =
  | Refused
  | Unavailable
  | Unknown
  | Malformed
  | Changed
  /** Se la quitó a sí misma: la base cerró sus sesiones, y su cookie ya no está. */
  | { kind: "revoked_self" }
  | { kind: "answered"; answer: RevokeAnswer };
export type FactorReset =
  | Refused
  | Unavailable
  | Unknown
  | Malformed
  | Changed
  /** Quien actúa ya la restableció con esa confirmación: es su envío repetido. No se tocó nada. */
  | { kind: "already_sent" }
  /** El código que hay que dictarle. Sale una sola vez: no se guarda en ningún lado. */
  | { kind: "reset"; code: string }
  | { kind: "answered"; answer: Exclude<ResetAnswer, "reset"> };
export type FreshCode =
  | Refused
  | Unavailable
  | { kind: "verified" }
  | { kind: "wrong_code" }
  /** El freno rechazó: Auth cerró todas sus sesiones. */
  | { kind: "throttled" }
  /** Su código fue el bueno, y aun así ningún cambio pasaría: es configuración. */
  | { kind: "not_available" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** La forma de la versión de una persona: `n.a`, dos contadores (`private.reset_version()`). */
export const RESET_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** Un identificador con forma, o nulo. Solo minúsculas: así dos iguales se escriben igual. */
function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/** Una versión con forma, o nula. */
function versionOf(value: unknown): string | null {
  return typeof value === "string" && RESET_VERSION.test(value) ? value : null;
}

function capabilityOf(value: unknown): Capability | null {
  return CAPABILITIES.find((capability) => capability === value) ?? null;
}

/** Una lista de capacidades sin repetidos y en su orden, o nulo si viene vacía o trae otra cosa. */
function capabilitiesOf(value: unknown): Capability[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CAPABILITIES.length * 2) return null;
  const typed: unknown[] = value;
  if (!typed.every((each) => capabilityOf(each) !== null)) return null;
  return CAPABILITIES.filter((capability) => typed.includes(capability));
}

/** Lo que pasa, además de quitarla, al quitarle una capacidad a alguien. */
export type RemovalEffect = "self" | "last" | "inviter";

/**
 * Qué más pasa al quitarle esa capacidad a esa persona, para que la confirmación lo diga y
 * el servicio compruebe que sigue siendo cierto. Nulo si la persona no está en la lista o no
 * tiene esa capacidad.
 *
 *   self     es quien actúa: la base cierra también sus sesiones
 *   last     es su última capacidad: deja de ser del equipo, sin atadura ni factores
 *   inviter  pierde configuración y tiene invitaciones vivas hechas por ella: se revocan
 */
export function removalEffects(roster: TeamRoster, profileId: string, capability: Capability): RemovalEffect[] | null {
  const member = roster.members.find((each) => each.profileId === profileId);
  if (!member?.capabilities.includes(capability)) return null;
  const effects: RemovalEffect[] = [];
  if (member.isSelf) effects.push("self");
  if (member.capabilities.length === 1) effects.push("last");
  if (capability === "config" && roster.invitations.some((invitation) => invitation.invitedBy === profileId)) effects.push("inviter");
  return effects;
}

/** Lo que pasa, además de lo de siempre, al restablecerle el segundo factor a alguien. */
export type ResetEffect = "alone" | "inviter" | "again";

/**
 * Qué más pasa al restablecer a esa persona. Nulo si no está en la lista, es quien actúa,
 * o su cuenta no está activa: a esas no se les restablece.
 *
 *   alone    hoy puede cambiar el equipo (configuración, y su factor en regla) y nadie más
 *            puede: quien actúa queda como la única. Si ya no podía, restablecerla otra vez
 *            no cambia eso, y no se dice
 *   inviter  tiene invitaciones vivas hechas por ella: se revocan
 *   again    ya estaba sin atadura: el código que se le hubiera dictado deja de servir
 */
export function resetEffects(roster: TeamRoster, profileId: string): ResetEffect[] | null {
  const member = roster.members.find((each) => each.profileId === profileId);
  if (!member || member.isSelf || member.status !== "active") return null;
  const effects: ResetEffect[] = [];
  const others = roster.members.filter((each) => !each.isSelf && each.profileId !== profileId);
  const operative = (each: TeamMember) => each.status === "active" && each.factor === "bound" && each.capabilities.includes("config");
  if (operative(member) && !others.some(operative)) effects.push("alone");
  if (roster.invitations.some((invitation) => invitation.invitedBy === profileId)) effects.push("inviter");
  if (member.factor === "none") effects.push("again");
  return effects;
}

/** Los efectos, como viajan en el botón de confirmar: lo que se confirmó se compara con lo de ahora. */
export function effectsKey(effects: readonly string[]): string {
  return effects.join("+");
}

// Sin 0, 1, I, L ni O: se dicta por voz, y esas se confunden.
const DICTATED_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const DICTATED_LENGTH = 16;

/**
 * Un código para dictar: dieciséis caracteres al azar, en cuatro grupos de cuatro. Los
 * guiones son para leerlo; quien lo teclea puede ponerlos o no (`handoffPrint`).
 */
export function dictatedCode(pick: (max: number) => number = randomInt): string {
  let code = "";
  for (let index = 0; index < DICTATED_LENGTH; index += 1) {
    if (index > 0 && index % 4 === 0) code += "-";
    code += DICTATED_ALPHABET.charAt(pick(DICTATED_ALPHABET.length));
  }
  return code;
}

export interface TeamAdminCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  giveSecondFactorCode: (jar: CookieJar, code: string) => Promise<CodeGiven>;
  store: TeamAdminStore;
  /** Solo para las pruebas: el código dictado. */
  dictate?: () => string;
}

export function createTeamAdmin(deps: Pick<AccountDependencies, "auth" | "report">, core: TeamAdminCore) {
  const { store } = core;
  const dictate = core.dictate ?? dictatedCode;

  /** Quien pide, si es del equipo con configuración y su sesión pasa la puerta. */
  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "config")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /** Un cambio: lo que la base contestó, o «no se supo» si no contestó algo de su lista. */
  async function change<Answer>(work: () => Promise<Answer>): Promise<{ kind: "answered"; answer: Answer } | Unknown> {
    try {
      return { kind: "answered", answer: await work() };
    } catch {
      await deps.report("team_change_unavailable");
      return { kind: "unknown" };
    }
  }

  /** La lista, para comprobar algo antes de un cambio. */
  async function rosterFor(claims: VerifiedClaims): Promise<{ ok: true; roster: TeamRoster } | { ok: false; result: Refused | Unavailable }> {
    let roster: TeamRoster | null;
    try {
      roster = await store.roster(claims);
    } catch {
      await deps.report("team_roster_unavailable");
      return { ok: false, result: { kind: "unavailable" } };
    }
    // Nula: entre la guarda y la lectura dejó de pasar la puerta. Decide la página.
    if (roster === null) return { ok: false, result: { kind: "refused" } };
    return { ok: true, roster };
  }

  /**
   * La lista del equipo, para la página que ya pasó su guarda: se lee con las claims que esa
   * guarda le dio. Una lectura nula, o sin la fila de quien pregunta, no vale: la sesión pudo
   * dejar de pasar la puerta entre la guarda y la lectura, y entonces no es una caída. Se le
   * vuelve a preguntar a la guarda, y solo si insiste en que pasa se reporta.
   */
  async function teamRoster(reader: CookieReader, claims: VerifiedClaims): Promise<RosterRead> {
    try {
      const roster = await store.roster(claims);
      if (roster?.members.some((member) => member.isSelf && member.profileId === claims.userId)) return { kind: "roster", roster };
    } catch {
      await deps.report("team_roster_unavailable");
      return { kind: "unavailable" };
    }
    const now = await core.teamStanding(reader);
    if (now.kind === "team" && holds(now.standing, "config")) await deps.report("team_roster_unavailable");
    return { kind: "unavailable" };
  }

  /** Invitar a un correo a recibir capacidades. No manda ningún correo. */
  async function inviteAdmin(jar: CookieJar, input: { email: unknown; capabilities: unknown }): Promise<InviteResult> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const email = parseEmail(typeof input.email === "string" ? input.email : "");
    const capabilities = capabilitiesOf(input.capabilities);
    if (!email.ok || capabilities === null) {
      return { kind: "malformed", email: email.ok ? null : email.reason, capabilities: capabilities === null };
    }
    return change(() => store.invite(admitted.claims, email.email, capabilities));
  }

  /**
   * Invitar de nuevo a quien tenía una invitación que caducó. A quién y con qué sale de lo
   * que la base tiene de esa invitación, no del formulario. Solo las que dan capacidades:
   * una de restablecimiento caducada se arregla restableciendo otra vez.
   */
  async function reinviteAdmin(jar: CookieJar, input: { id: unknown }): Promise<ReinviteResult> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const id = idOf(input.id);
    if (id === null) return { kind: "malformed" };
    const read = await rosterFor(admitted.claims);
    if (!read.ok) return read.result;
    const invitation = read.roster.invitations.find((each) => each.id === id);
    if (invitation?.kind !== "grant" || !invitation.expired) return { kind: "gone" };
    return change(() => store.invite(admitted.claims, invitation.email, invitation.capabilities));
  }

  /** Revocar una invitación viva, de cualquier tipo. */
  async function revokeInvitation(jar: CookieJar, input: { id: unknown }): Promise<InvitationRevoked> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const id = idOf(input.id);
    if (id === null) return { kind: "malformed" };
    return change(() => store.revokeInvitation(admitted.claims, id));
  }

  /** Darle una capacidad a alguien que ya es del equipo. */
  async function grantCapability(jar: CookieJar, input: { profile: unknown; capability: unknown }): Promise<CapabilityGranted> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const profile = idOf(input.profile);
    const capability = capabilityOf(input.capability);
    if (profile === null || capability === null) return { kind: "malformed" };
    return change(() => store.grant(admitted.claims, profile, capability));
  }

  /**
   * Quitarle una capacidad a alguien. `confirmed` es lo que la persona confirmó que pasaría
   * (`effectsKey(removalEffects(…))`): si ya no es eso, no se quita y se confirma otra vez.
   *
   * La base cierra todas las sesiones de esa persona, también si es quien actúa: entonces
   * aquí se borra su cookie, y la pantalla la manda a entrar.
   */
  async function revokeCapability(
    jar: CookieJar,
    input: { profile: unknown; capability: unknown; confirmed: unknown },
  ): Promise<CapabilityRevoked> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const profile = idOf(input.profile);
    const capability = capabilityOf(input.capability);
    if (profile === null || capability === null) return { kind: "malformed" };
    const read = await rosterFor(admitted.claims);
    if (!read.ok) return read.result;
    const effects = removalEffects(read.roster, profile, capability);
    if (effects === null || effectsKey(effects) !== input.confirmed) return { kind: "changed" };

    const result = await change(() => store.revoke(admitted.claims, profile, capability));
    if (result.kind === "answered" && result.answer === "revoked" && profile === admitted.claims.userId) {
      // La base ya cerró la sesión. Esto borra su cookie, y Auth contesta que no existe, que
      // cuenta como cerrada.
      if ((await deps.auth.signOut(jar)) !== "closed") await deps.report("session_not_closed");
      return { kind: "revoked_self" };
    }
    return result;
  }

  /**
   * Restablecerle el segundo factor a alguien del equipo. Genera aquí el código que quien
   * actúa le va a dictar por otro canal, y a la base le manda solo su huella, calculada con
   * la misma función con la que se comprobará al aceptar. El código sale en la respuesta una
   * sola vez, y solo si la base restableció: no se guarda ni se reporta.
   *
   * Un formulario reenviado (un doble clic, o recargar) no restablece otra vez: `version` es
   * la versión de la persona que la pantalla puso en el botón, y si ya no es esa no se hace
   * nada. Se mira primero en la lista, para que recargar después de restablecer diga «ya se
   * envió» y no «la lista cambió»; y la base la vuelve a comparar dentro de su candado, que
   * es lo que de verdad impide dos restablecimientos a la vez. Con la misma regla en los dos
   * lados: «ya se envió» solo si lo pendiente es un restablecimiento de quien actúa.
   */
  async function resetSecondFactor(
    jar: CookieJar,
    input: { profile: unknown; confirmed: unknown; version: unknown },
  ): Promise<FactorReset> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const profile = idOf(input.profile);
    const version = versionOf(input.version);
    // Nadie se restablece a sí misma: la pantalla no lo ofrece, y la base lo diría.
    if (profile === null || version === null || profile === admitted.claims.userId) return { kind: "malformed" };
    const read = await rosterFor(admitted.claims);
    if (!read.ok) return read.result;
    const member = read.roster.members.find((each) => each.profileId === profile);
    if (member !== undefined && member.resetVersion !== version) {
      const mine = read.roster.invitations.some(
        (each) => each.kind === "rebind" && each.profileId === profile && each.invitedBy === admitted.claims.userId,
      );
      return mine ? { kind: "already_sent" } : { kind: "changed" };
    }
    const effects = resetEffects(read.roster, profile);
    if (effects === null || effectsKey(effects) !== input.confirmed) return { kind: "changed" };

    const code = dictate();
    const print = handoffPrint(code);
    if (print === null) {
      // El código generado no tiene la forma que aceptar comprobará: no se manda nada.
      await deps.report("team_change_unavailable");
      return { kind: "unknown" };
    }
    const result = await change(() => store.resetFactor(admitted.claims, profile, print, version));
    if (result.kind !== "answered") return result;
    switch (result.answer) {
      case "reset":
        return { kind: "reset", code };
      // Otro envío ganó el candado entre la lista y la base: lo mismo que si la lista lo
      // hubiera dicho.
      case "already_sent":
        return { kind: "already_sent" };
      case "changed":
        return { kind: "changed" };
      default:
        return { kind: "answered", answer: result.answer };
    }
  }

  /**
   * Dar el código otra vez, para que un cambio al equipo pase su puerta. Verificado, la
   * lista tiene que decir que el código ya es reciente: si no, pedirlo otra vez no arregla
   * nada (falta VIGENCIA_CODIGO_RECIENTE_MINUTOS, o no vale), y se dice y se reporta.
   */
  async function giveFreshCode(jar: CookieJar, code: string): Promise<FreshCode> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const given = await core.giveSecondFactorCode(jar, code);
    switch (given.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
      case "unavailable":
        return { kind: given.kind };
      default:
        // Dejó de ser del equipo, o su sesión ya no vale: decide la página.
        return { kind: "refused" };
    }
    // Con la sesión como quedó en ese tarro: verificar escribió su cookie.
    const now = await admit(jar);
    if (!now.ok) return now.result;
    try {
      if ((await store.roster(now.claims))?.freshCode === true) return { kind: "verified" };
    } catch {
      // Se reporta abajo.
    }
    await deps.report("team_change_unavailable");
    return { kind: "not_available" };
  }

  return {
    teamRoster,
    inviteAdmin,
    reinviteAdmin,
    revokeInvitation,
    grantCapability,
    revokeCapability,
    resetSecondFactor,
    giveFreshCode,
  };
}
