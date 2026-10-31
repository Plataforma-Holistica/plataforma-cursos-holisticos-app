import "server-only";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { parseEmail } from "@/services/account/field-rules";
import { holds, type CodeGiven, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

import { teacherVersion } from "./version";

export { teacherVersion };

// Administrar a los maestros (RF-104, RF-702; PA-65 y PA-66, FL-46; T-401). Lo cambia solo alguien del equipo con
// Contenido y un código reciente: lo decide la base, con su propia puerta. Aquí se decide a quién se le pregunta qué
// y en qué orden, como en las prácticas y los niveles:
//
//   · La guarda va primero, siempre: `teamStanding`, y solo sigue quien es del equipo con Contenido. Los demás reciben
//     `refused`, sin distinguir por qué. Si no se supo quién pide, `unavailable`.
//   · Lo que llega se revisa antes de tocar la base. Lo que no tiene forma no llega (`malformed`).
//   · Nada de lo que llega dice quién actúa: sale de la sesión que pasó la guarda.
//   · Cada cambio a un maestro lleva lo que se vio de él (`teacherVersion`), y se relee antes: si ya no es eso,
//     contesta `changed` sin hacer nada. La regla la sigue decidiendo la base.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra la lista cerrada de su función. Otra
//     cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.

export const TEACHER_STATUSES = ["invited", "active", "suspended", "left"] as const;
export type TeacherStatus = (typeof TEACHER_STATUSES)[number];
export const INVITATION_STATES = ["none", "accepted", "revoked", "expired", "pending"] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

export interface TeacherRow {
  id: string;
  name: string | null;
  status: TeacherStatus;
  founderSince: string | null;
  email: string | null;
  invitation: InvitationState;
  expiresAt: string | null;
  suspension: "fraud" | "manual" | null;
  suspendedAt: string | null;
  /** El motivo interno. El maestro no lo ve. */
  suspensionReason: string | null;
  /** Lo que el maestro lee. */
  suspensionNotice: string | null;
  fraudPending: boolean;
  /** Es el maestro de quien lee: la pantalla no le ofrece actuar sobre sí. */
  isSelf: boolean;
  /** Ya capturó sus datos fiscales. Contenido lo sabe para pedírselos, y no los ve. */
  hasTaxData: boolean;
}

/** Una suspensión por fraude que finanzas propuso y falta confirmar (RN-17). La base no le lista a nadie la que es sobre sí. */
export interface FraudRequest {
  id: string;
  teacherId: string;
  name: string | null;
  reason: string;
  proposedAt: string;
  proposedBySelf: boolean;
  markedBySelf: boolean;
  period: number;
  metric: number;
  threshold: number;
}

export interface TeacherRoster {
  /** Un cambio pasaría hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  teachers: TeacherRow[];
  requests: FraudRequest[];
}

const GATE = ["forbidden", "needs_fresh_code"] as const;
const PLACED = ["invalid", "unavailable", "self", "ineligible", "already_teacher", "already_invited", "invited_new", "invited_existing"] as const;
export const INVITE_ANSWERS = [...GATE, ...PLACED] as const;
export const REINVITE_ANSWERS = [...GATE, "not_found", ...PLACED] as const;
export const REVOKE_ANSWERS = [...GATE, "self", "not_found", "revoked"] as const;
export const FOUNDER_ANSWERS = [...GATE, "not_found", "self", "unchanged", "too_early", "locked", "set", "cleared"] as const;
export const SUSPEND_ANSWERS = [...GATE, "not_found", "self", "invalid", "already_suspended", "not_active", "suspended"] as const;
export const LIFT_ANSWERS = [...GATE, "not_found", "self", "proposer", "not_suspended", "lifted"] as const;
export const DECIDE_ANSWERS = [...GATE, "not_found", "self", "proposer", "invalid", "not_active", "confirmed", "rejected"] as const;
export type InviteAnswer = (typeof INVITE_ANSWERS)[number];
export type ReinviteAnswer = (typeof REINVITE_ANSWERS)[number];
export type RevokeAnswer = (typeof REVOKE_ANSWERS)[number];
export type FounderAnswer = (typeof FOUNDER_ANSWERS)[number];
export type SuspendAnswer = (typeof SUSPEND_ANSWERS)[number];
export type LiftAnswer = (typeof LIFT_ANSWERS)[number];
export type DecideAnswer = (typeof DECIDE_ANSWERS)[number];

/** Lo que estos servicios le preguntan a la base. La lista es nula si quien actúa no pasa su puerta con Contenido. */
export interface TeacherAdminStore {
  roster(claims: VerifiedClaims): Promise<TeacherRoster | null>;
  invite(claims: VerifiedClaims, name: string, email: string): Promise<InviteAnswer>;
  reinvite(claims: VerifiedClaims, teacher: string): Promise<ReinviteAnswer>;
  revoke(claims: VerifiedClaims, teacher: string): Promise<RevokeAnswer>;
  setFounder(claims: VerifiedClaims, teacher: string, since: string | null): Promise<FounderAnswer>;
  suspend(claims: VerifiedClaims, teacher: string, reason: string, notice: string): Promise<SuspendAnswer>;
  lift(claims: VerifiedClaims, teacher: string): Promise<LiftAnswer>;
  decide(claims: VerifiedClaims, request: string, confirm: boolean, note: string | null, notice: string | null): Promise<DecideAnswer>;
}

interface Refused {
  kind: "refused";
}
interface Unavailable {
  kind: "unavailable";
}
interface Unknown {
  kind: "unknown";
}
interface Malformed {
  kind: "malformed";
}
/** Lo que se vio de ese maestro ya no es: no se hizo nada. */
interface Changed {
  kind: "changed";
}

export type RosterRead = { kind: "roster"; roster: TeacherRoster } | Unavailable;
export type TeacherInvited = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: InviteAnswer };
export type TeacherChange<Answer> = Refused | Unavailable | Unknown | Malformed | Changed | { kind: "answered"; answer: Answer };
export type TeacherCode =
  | Refused
  | Unavailable
  | { kind: "verified" }
  | { kind: "wrong_code" }
  | { kind: "throttled" }
  | { kind: "not_available" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Los topes, los mismos que la base. */
export const TEACHER_NAME_MAX = 80;
export const SUSPENSION_REASON_MAX = 1_000;
export const SUSPENSION_NOTICE_MAX = 300;
export const FRAUD_NOTE_MAX = 4_000;

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/** Un texto ya sin espacios a los lados, de 1 al tope, o nulo. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // El navegador manda cada salto de línea como dos caracteres, y su `maxLength` lo contó como uno.
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

/** Un día de verdad del calendario, o nulo. */
export function founderDayOf(value: unknown): string | null {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export interface TeacherAdminCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  giveSecondFactorCode: (jar: CookieJar, code: string) => Promise<CodeGiven>;
  store: TeacherAdminStore;
}

export function createTeacherAdmin(deps: { report: (code: FailureCode) => Promise<void> }, core: TeacherAdminCore) {
  const { store } = core;

  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "content")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /**
   * La lista, para la sección que ya pasó su guarda. Leer no pide el código reciente. Una lectura nula (la sesión dejó
   * de pasar entre la guarda y esta lectura) o que no se pudo hacer es «no se supo»; solo la segunda se reporta.
   */
  async function teacherRoster(claims: VerifiedClaims): Promise<RosterRead> {
    try {
      const roster = await store.roster(claims);
      return roster === null ? { kind: "unavailable" } : { kind: "roster", roster };
    } catch {
      await deps.report("teacher_roster_unavailable");
      return { kind: "unavailable" };
    }
  }

  async function answered<Answer>(work: () => Promise<Answer>): Promise<{ kind: "answered"; answer: Answer } | Unknown> {
    try {
      return { kind: "answered", answer: await work() };
    } catch {
      await deps.report("teacher_change_unavailable");
      return { kind: "unknown" };
    }
  }

  /**
   * Un cambio a un maestro: la guarda, lo que se vio contra lo de ahora, y el cambio. Si no se pudo releer, no se sabe si
   * sigue siendo lo que se vio: no se intenta.
   */
  async function onTeacher<Answer>(
    jar: CookieReader,
    teacher: unknown,
    seen: unknown,
    work: (claims: VerifiedClaims, id: string, roster: TeacherRoster) => Promise<Answer>,
  ): Promise<TeacherChange<Answer>> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const id = idOf(teacher);
    if (id === null || typeof seen !== "string") return { kind: "malformed" };
    const read = await teacherRoster(admitted.claims);
    if (read.kind !== "roster") return { kind: "unavailable" };
    const row = read.roster.teachers.find((each) => each.id === id);
    if (row === undefined || teacherVersion(row) !== seen) return { kind: "changed" };
    return answered(() => work(admitted.claims, id, read.roster));
  }

  async function inviteTeacher(jar: CookieReader, input: { name: unknown; email: unknown }): Promise<TeacherInvited> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const name = textOf(input.name, TEACHER_NAME_MAX);
    const parsed = typeof input.email === "string" ? parseEmail(input.email) : null;
    if (name === null || parsed === null || !parsed.ok) return { kind: "malformed" };
    return answered(() => store.invite(admitted.claims, name, parsed.email));
  }

  const reinviteTeacher = (jar: CookieReader, input: { teacher: unknown; seen: unknown }) =>
    onTeacher(jar, input.teacher, input.seen, (claims, id) => store.reinvite(claims, id));

  const revokeTeacherInvitation = (jar: CookieReader, input: { teacher: unknown; seen: unknown }) =>
    onTeacher(jar, input.teacher, input.seen, (claims, id) => store.revoke(claims, id));

  /** Marcar fundador desde un día, o quitarlo con `since` nulo. */
  async function setTeacherFounder(
    jar: CookieReader,
    input: { teacher: unknown; seen: unknown; since: unknown },
  ): Promise<TeacherChange<FounderAnswer>> {
    const since = input.since === null ? null : founderDayOf(input.since);
    if (input.since !== null && since === null) {
      const admitted = await admit(jar);
      return admitted.ok ? { kind: "malformed" } : admitted.result;
    }
    return onTeacher(jar, input.teacher, input.seen, (claims, id) => store.setFounder(claims, id, since));
  }

  async function suspendTeacher(
    jar: CookieReader,
    input: { teacher: unknown; seen: unknown; reason: unknown; notice: unknown },
  ): Promise<TeacherChange<SuspendAnswer>> {
    const reason = textOf(input.reason, SUSPENSION_REASON_MAX);
    const notice = textOf(input.notice, SUSPENSION_NOTICE_MAX);
    if (reason === null || notice === null) {
      const admitted = await admit(jar);
      return admitted.ok ? { kind: "malformed" } : admitted.result;
    }
    return onTeacher(jar, input.teacher, input.seen, (claims, id) => store.suspend(claims, id, reason, notice));
  }

  const liftTeacherSuspension = (jar: CookieReader, input: { teacher: unknown; seen: unknown }) =>
    onTeacher(jar, input.teacher, input.seen, (claims, id) => store.lift(claims, id));

  /**
   * Confirmar o rechazar la propuesta de fraude de ese maestro. Confirmar pide el texto para el maestro. Que la propuesta
   * sea de ese maestro se comprueba en la lista: el identificador llega del formulario.
   */
  async function decideTeacherFraud(
    jar: CookieReader,
    input: { teacher: unknown; seen: unknown; request: unknown; confirm: boolean; note: unknown; notice: unknown },
  ): Promise<TeacherChange<DecideAnswer>> {
    const request = idOf(input.request);
    const blank = input.note === null || (typeof input.note === "string" && input.note.trim() === "");
    const note = blank ? null : textOf(input.note, FRAUD_NOTE_MAX);
    const notice = input.confirm ? textOf(input.notice, SUSPENSION_NOTICE_MAX) : null;
    if (request === null || (!blank && note === null) || (input.confirm && notice === null)) {
      const admitted = await admit(jar);
      return admitted.ok ? { kind: "malformed" } : admitted.result;
    }
    return onTeacher(jar, input.teacher, input.seen, async (claims, id, roster) => {
      if (!roster.requests.some((each) => each.id === request && each.teacherId === id)) return "not_found";
      return store.decide(claims, request, input.confirm, note, notice);
    });
  }

  /** Dar el código otra vez: lo reciente se comprueba con esta misma lista, que solo pide Contenido. */
  async function giveTeacherCode(jar: CookieJar, code: string): Promise<TeacherCode> {
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
        return { kind: "refused" };
    }
    // Con la sesión como quedó en ese tarro: verificar escribió su cookie.
    const again = await admit(jar);
    if (!again.ok) return again.result;
    let roster: TeacherRoster | null;
    try {
      roster = await store.roster(again.claims);
    } catch {
      await deps.report("teacher_change_unavailable");
      return { kind: "not_available" };
    }
    if (roster === null) return { kind: "refused" };
    if (roster.freshCode) return { kind: "verified" };
    await deps.report("teacher_change_unavailable");
    return { kind: "not_available" };
  }

  return {
    teacherRoster,
    inviteTeacher,
    reinviteTeacher,
    revokeTeacherInvitation,
    setTeacherFounder,
    suspendTeacher,
    liftTeacherSuspension,
    decideTeacherFraud,
    giveTeacherCode,
  };
}
