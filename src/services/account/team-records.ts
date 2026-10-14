import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { ACCEPT_ANSWERS, CAPABILITIES, type AcceptAnswer, type Capability, type TeamStanding } from "./team";
import type { TeamRoster } from "./team-admin";

// Lo que los servicios del equipo le preguntan a la base (esquema §6.2): en qué estado está
// quien actúa, aceptar su invitación, la lista del equipo y los cinco cambios. Cada función
// recibe la transacción ya abierta como servidor: por quién se actúa y con qué sesión lo
// declaró quien la abrió, con las claims que verificó. Ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const standingRow = z.object({
  state: z.string(),
  factor: z.string().nullable(),
  kind: z.string().nullable(),
  capabilities: z.array(z.string()),
});

export type StandingRow = z.infer<typeof standingRow>;

/**
 * Lo que contestó la base, como uno de los seis estados. Lo que no encaje lanza: un estado
 * que no se conoce, un `member` sin su factor o una invitación sin su tipo no se adivinan,
 * y quien llama lo trata como «no se supo».
 */
export function standingOf(row: StandingRow): TeamStanding {
  const factor = row.factor !== null && ID.test(row.factor) ? row.factor : null;
  const kind = row.kind === "grant" || row.kind === "rebind" ? row.kind : null;
  switch (row.state) {
    case "none":
    case "unbound":
      return { state: row.state };
    case "member":
      if (factor !== null && row.capabilities.length > 0) return { state: "member", factor, capabilities: row.capabilities };
      break;
    case "needs_code":
      if (factor !== null) return { state: "needs_code", factor };
      break;
    case "invited":
      if (kind !== null) return { state: "invited", kind, capabilities: row.capabilities };
      break;
    case "invited_unproven":
      if (kind !== null) return { state: "invited_unproven", kind };
      break;
  }
  throw new Error("La base contestó un estado del equipo que no se entiende.");
}

/**
 * En qué estado está quien actúa respecto al equipo (`private.team_standing()`).
 * `ticketPrint` es la huella del resguardo del buzón que trae su navegador, o nulo. No
 * escribe nada.
 */
export async function readTeamStanding(tx: Tx, ticketPrint: string | null): Promise<TeamStanding> {
  const [row] = await tx.query(
    sql`select state, factor::text as factor, kind, capabilities
        from private.team_standing(${ticketPrint}::text)`,
    standingRow,
  );
  if (!row) throw new Error("La base no contestó el estado del equipo.");
  return standingOf(row);
}

const acceptRow = z.object({ answer: z.string() });

/**
 * Acepta la invitación de quien actúa (`private.accept_admin_invitation()`), con la huella
 * del resguardo, el factor que el servidor dio de alta en ese navegador y, en un
 * restablecimiento, la huella del código dictado. Devuelve lo que contestó la base, tal
 * cual: se entiende con `acceptAnswerOf`, ya confirmada la transacción.
 *
 * Tres de sus rechazos escriben antes de contestar (cuentan el fallo o revocan la
 * invitación): la transacción se confirma con cualquier respuesta. Por eso aquí no se
 * valida qué contestó: lanzar dentro revertiría lo que el rechazo escribió, y el límite de
 * códigos dictados no contaría nada.
 */
export async function acceptInvitation(
  tx: Tx,
  ticketPrint: string,
  factorId: string,
  handoffPrint: string | null,
): Promise<string> {
  const [row] = await tx.query(
    sql`select private.accept_admin_invitation(${ticketPrint}::text, ${factorId}::uuid, ${handoffPrint}::text) as answer`,
    acceptRow,
  );
  return row?.answer ?? "";
}

/** Lo que contestó aceptar, como una de sus nueve respuestas. Otra cosa lanza: no se adivina. */
export function acceptAnswerOf(answer: string): AcceptAnswer {
  const known = ACCEPT_ANSWERS.find((candidate) => candidate === answer);
  if (known === undefined) throw new Error("La base contestó algo que aceptar una invitación no contesta.");
  return known;
}

// ---------------------------------------------------------------------------------------
// Administrar al equipo (RF-712): la lista, y los cinco cambios.

const id = z.string().regex(ID);
const capability = z.enum(CAPABILITIES);

// Objetos estrictos: un campo que este código no conoce no pasa. La base no devuelve la
// clave de un factor ni la huella de un código dictado, y si un día lo hiciera, aquí se
// rechaza en vez de viajar hacia la pantalla.
const rosterShape = z.strictObject({
  fresh_code: z.boolean(),
  members: z
    .array(
      z.strictObject({
        profile_id: id,
        email: z.string().nullable(),
        display_name: z.string().nullable(),
        status: z.string(),
        capabilities: z.array(capability).min(1),
        factor: z.enum(["bound", "lost", "none"]),
        rebind: z.enum(["none", "pending", "expired", "unusable"]),
        config_removable: z.boolean(),
        is_self: z.boolean(),
      }),
    )
    .min(1),
  invitations: z.array(
    z.strictObject({
      id,
      kind: z.enum(["grant", "rebind"]),
      email: z.string(),
      profile_id: id.nullable(),
      capabilities: z.array(capability),
      invited_by: id.nullable(),
      // Como texto, y no como fecha con forma: un plazo desmedido da un año de cinco cifras,
      // y rechazarlo tumbaría la pantalla entera por una sola invitación. Una fecha que no
      // se entiende simplemente no se pinta.
      created_at: z.string(),
      expires_at: z.string(),
      expired: z.boolean(),
      acceptable: z.boolean(),
    }),
  ),
});

const rosterRow = z.object({ roster: z.unknown() });

/** Las capacidades, en el orden en que la aplicación las nombra. */
function inOrder(capabilities: readonly Capability[]): Capability[] {
  return CAPABILITIES.filter((each) => capabilities.includes(each));
}

/**
 * Lo que contestó `private.team_roster()`, o nulo si contestó nulo: quien actúa no pasa la
 * puerta del equipo con configuración. Lo que no encaje lanza: no se adivina, y quien llama
 * lo trata como «no se supo».
 */
export function rosterOf(raw: unknown): TeamRoster | null {
  if (raw === null) return null;
  const roster = rosterShape.parse(raw);
  // Quien pregunta sale en su propia lista, una sola vez: sin eso no es una lista que valga.
  if (roster.members.filter((member) => member.is_self).length !== 1) {
    throw new Error("La base contestó una lista del equipo que no se entiende.");
  }
  return {
    freshCode: roster.fresh_code,
    members: roster.members.map((member) => ({
      profileId: member.profile_id,
      email: member.email,
      displayName: member.display_name,
      status: member.status === "active" || member.status === "suspended" ? member.status : "other",
      capabilities: inOrder(member.capabilities),
      factor: member.factor,
      rebind: member.rebind,
      configRemovable: member.config_removable,
      isSelf: member.is_self,
    })),
    invitations: roster.invitations.map((invitation) => ({
      id: invitation.id,
      kind: invitation.kind,
      email: invitation.email,
      profileId: invitation.profile_id,
      // En el orden en que se pidieron: es lo que la persona invitó.
      capabilities: invitation.capabilities,
      invitedBy: invitation.invited_by,
      createdAt: new Date(invitation.created_at),
      expiresAt: new Date(invitation.expires_at),
      expired: invitation.expired,
      acceptable: invitation.acceptable,
    })),
  };
}

/** La lista del equipo para quien actúa (`private.team_roster()`). No escribe nada. */
export async function readTeamRoster(tx: Tx): Promise<TeamRoster | null> {
  const [row] = await tx.query(sql`select private.team_roster() as roster`, rosterRow);
  if (!row) throw new Error("La base no contestó la lista del equipo.");
  return rosterOf(row.roster);
}

const answerRow = z.object({ answer: z.string() });

// Las cinco de abajo devuelven lo que contestó la base, tal cual: se entiende con
// `answerOf`, ya confirmada la transacción. Ninguna escribe antes de rechazar, así que
// lanzar dentro no perdería nada; se hace fuera para que las cinco se lean como aceptar.

/** Invita a un correo a recibir capacidades (`private.invite_admin()`). */
export async function askInvite(tx: Tx, email: string, capabilities: readonly Capability[]): Promise<string> {
  const [row] = await tx.query(
    sql`select private.invite_admin(${email}::text, ${[...capabilities]}::text[]::public.capability[]) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}

/** Revoca una invitación viva (`private.revoke_admin_invitation()`). */
export async function askRevokeInvitation(tx: Tx, invitationId: string): Promise<string> {
  const [row] = await tx.query(sql`select private.revoke_admin_invitation(${invitationId}::uuid) as answer`, answerRow);
  return row?.answer ?? "";
}

/** Da una capacidad a alguien del equipo (`private.grant_capability()`). */
export async function askGrant(tx: Tx, profileId: string, granted: Capability): Promise<string> {
  const [row] = await tx.query(
    sql`select private.grant_capability(${profileId}::uuid, ${granted}::text::public.capability) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}

/** Quita una capacidad (`private.revoke_capability()`). */
export async function askRevoke(tx: Tx, profileId: string, revoked: Capability): Promise<string> {
  const [row] = await tx.query(
    sql`select private.revoke_capability(${profileId}::uuid, ${revoked}::text::public.capability) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}

/**
 * Restablece el segundo factor de alguien del equipo (`private.reset_second_factor()`).
 * `handoff` es la huella del código que quien actúa va a dictarle, nunca el código.
 */
export async function askReset(tx: Tx, profileId: string, handoff: string): Promise<string> {
  const [row] = await tx.query(sql`select private.reset_second_factor(${profileId}::uuid, ${handoff}::text) as answer`, answerRow);
  return row?.answer ?? "";
}

/** Lo que contestó un cambio al equipo, como una de las respuestas de su lista. Otra cosa lanza. */
export function answerOf<Answer extends string>(known: readonly Answer[], answer: string): Answer {
  const found = known.find((candidate) => candidate === answer);
  if (found === undefined) throw new Error("La base contestó algo que ese cambio al equipo no contesta.");
  return found;
}
