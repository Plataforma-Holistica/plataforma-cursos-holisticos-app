import { longDate } from "@/app/_lib/dates";
import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import {
  effectsKey,
  removalEffects,
  resetEffects,
  type TeamInvitation,
  type TeamMember,
  type TeamRoster,
} from "@/services/account/account";
import { CAPABILITIES, type Capability } from "@/services/account/team";

import { invitationButton, resetButton, teamButton, type TeamIntent } from "./outcomes";

// El equipo, puesto en palabras (diseño, PA-86). Lo arma la página, en el servidor, y la
// pantalla solo lo pinta: así el navegador no necesita saber leer fechas ni qué pasa al
// quitar una capacidad, y lo que se ve es lo mismo con JavaScript y sin él.
//
// Aquí se decide qué botón se ofrece en cada fila y qué dice su confirmación. No decide
// quién puede: eso lo hace la base, otra vez, cuando llega el envío. Y lo que una
// confirmación dice que va a pasar viaja en el valor de su botón, para que el servicio
// compruebe que siga siendo cierto.

const text = admin.team;
const names = account.admin.capabilities;

/** Lo que se pregunta antes de hacer algo que no se deshace solo. */
export interface Confirmation {
  title: string;
  /** Todo lo que va a pasar, una frase por renglón. */
  effects: string[];
  /** El valor del botón que lo hace. */
  value: string;
  button: string;
}

/** Un botón de una fila. `detail` es lo que dice además, para quien no ve la fila. */
export interface RowButton {
  label: string;
  detail: string;
  value: string;
}

/** Una capacidad en la fila de una persona: la tiene o no, y qué se puede hacer con ella. */
export interface CapabilityRow {
  capability: Capability;
  label: string;
  held: boolean;
  /** Quitarla si la tiene, darla si no. Nulo si no se ofrece. */
  button: RowButton | null;
  /** Por qué no se ofrece, cuando hay algo que decir. */
  locked: string | null;
  /** Nulo: el botón lo hace sin preguntar. */
  confirmation: Confirmation | null;
}

export interface MemberRow {
  id: string;
  /** Su identidad en la pantalla: el correo que la cuenta tiene hoy. */
  email: string;
  name: string | null;
  self: boolean;
  /** «Tiene: Contenido, Soporte.» */
  holds: string;
  /** Lo que hay que saber de esa cuenta: suspendida, sin segundo factor. */
  notes: string[];
  capabilities: CapabilityRow[];
}

export interface InvitationRow {
  id: string;
  email: string;
  /** Qué da, o que es para volver. */
  what: string;
  by: string;
  /** «Caduca el…», o nulo si ya caducó o la fecha no se entiende. */
  expires: string | null;
  notes: string[];
  revoke: RowButton & { confirmation: Confirmation };
  /** Solo para una que daba capacidades y caducó. */
  reinvite: RowButton | null;
}

/** Alguien a quien se le puede restablecer el segundo factor. */
export interface ResetOption {
  id: string;
  email: string;
  /** El primer paso: todavía no restablece. */
  choose: RowButton;
  confirmation: Confirmation;
}

export interface TeamView {
  /** El código de quien mira es reciente: se ofrecen los cambios. */
  canChange: boolean;
  /** Las capacidades que se pueden dar al invitar, en su orden. */
  capabilities: { value: Capability; label: string }[];
  members: MemberRow[];
  invitations: InvitationRow[];
  resettable: ResetOption[];
}

const emailOf = (member: Pick<TeamMember, "email">) => member.email ?? text.noEmail;

function notesOf(member: TeamMember): string[] {
  const notes: string[] = [];
  if (member.status === "suspended") notes.push(text.suspended);
  if (member.status === "other") notes.push(text.inactive);
  if (member.factor === "lost") notes.push(text.factorLost);
  if (member.factor === "none") {
    const rebind = { pending: text.rebindPending, expired: text.rebindExpired, unusable: text.rebindUnusable, none: text.rebindNone } as const;
    notes.push(rebind[member.rebind]);
  }
  return notes;
}

function heldRow(roster: TeamRoster, member: TeamMember, capability: Capability): CapabilityRow {
  const label = names[capability];
  const email = emailOf(member);
  const base = { capability, label, held: true } as const;
  // Lo mismo que contestaría la base: quedarían menos de dos cuentas activas con ella.
  if (capability === "config" && !member.configRemovable) {
    return { ...base, button: null, locked: t(text.configLocked, { capability: label }), confirmation: null };
  }
  const intent: TeamIntent = { type: "revoke", profile: member.profileId, capability };
  const effects = removalEffects(roster, member.profileId, capability) ?? [];
  const sentences: string[] = [text.effectSessions];
  if (effects.includes("self")) sentences.push(text.effectSelf);
  if (effects.includes("last")) sentences.push(text.effectLast);
  if (effects.includes("inviter")) sentences.push(text.effectInviter);
  sentences.push(text.effectLogged);
  return {
    ...base,
    button: { label: t(text.remove, { capability: label }), detail: t(text.toPerson, { email }), value: teamButton.ask(intent) },
    locked: null,
    confirmation: {
      title: t(text.confirmRemoveTitle, { capability: label, email }),
      effects: sentences,
      value: teamButton.confirm(intent, effectsKey(effects)),
      button: text.confirmRemove,
    },
  };
}

function missingRow(member: TeamMember, capability: Capability): CapabilityRow {
  const label = names[capability];
  const email = emailOf(member);
  const base = { capability, label, held: false } as const;
  // A una cuenta que no está activa no se le da nada. A quien no tiene atadura, tampoco: la
  // base contestaría que no es del equipo.
  if (member.status !== "active") return { ...base, button: null, locked: null, confirmation: null };
  if (member.factor === "none") return { ...base, button: null, locked: text.cannotGive, confirmation: null };
  const intent: TeamIntent = { type: "grant", profile: member.profileId, capability };
  const button = { label: t(text.give, { capability: label }), detail: t(text.toPerson, { email }) };
  // Dar configuración se pregunta: deshacerlo cierra las sesiones de esa persona.
  if (capability === "config") {
    return {
      ...base,
      button: { ...button, value: teamButton.ask(intent) },
      locked: null,
      confirmation: {
        title: t(text.confirmGiveTitle, { capability: label, email }),
        effects: [text.effectGiveConfig, text.effectLogged],
        value: teamButton.confirm(intent),
        button: text.confirmGive,
      },
    };
  }
  return { ...base, button: { ...button, value: teamButton.confirm(intent) }, locked: null, confirmation: null };
}

function memberRow(roster: TeamRoster, member: TeamMember): MemberRow {
  return {
    id: member.profileId,
    email: emailOf(member),
    name: member.displayName,
    self: member.isSelf,
    holds: t(text.holds, { capabilities: member.capabilities.map((capability) => names[capability]).join(", ") }),
    notes: notesOf(member),
    capabilities: CAPABILITIES.map((capability) =>
      member.capabilities.includes(capability) ? heldRow(roster, member, capability) : missingRow(member, capability),
    ),
  };
}

function invitationRow(roster: TeamRoster, invitation: TeamInvitation): InvitationRow {
  const { id, email } = invitation;
  const rebind = invitation.kind === "rebind";
  const inviter = roster.members.find((member) => member.profileId === invitation.invitedBy);
  // Una fecha que no se entiende no se pinta, y no tumba la página.
  const readable = !invitation.expired && !Number.isNaN(invitation.expiresAt.getTime());
  const date = readable ? longDate(invitation.expiresAt.toISOString()) : "";
  const notes: string[] = [];
  if (invitation.expired) notes.push(text.expired);
  // Una de restablecimiento que ya no sirve se arregla restableciendo otra vez; una que daba
  // capacidades y no caducó, revocándola e invitando de nuevo.
  if (rebind && !invitation.acceptable) notes.push(text.rebindNotAcceptable);
  if (!rebind && !invitation.expired && !invitation.acceptable) notes.push(text.notAcceptable);
  return {
    id,
    email,
    what: rebind
      ? text.invitationRebind
      : t(text.invitationGives, { capabilities: invitation.capabilities.map((capability) => names[capability]).join(", ") }),
    by: invitation.invitedBy === null ? text.invitedByOwner : inviter ? t(text.invitedBy, { email: emailOf(inviter) }) : text.invitedByGone,
    expires: date === "" ? null : t(text.expiresOn, { date }),
    notes,
    revoke: {
      label: text.revoke,
      detail: t(text.revokeDetail, { email }),
      value: invitationButton.ask(id),
      confirmation: {
        title: t(text.confirmRevokeTitle, { email }),
        effects: [rebind ? text.effectRevokeRebind : text.effectRevokeGrant, text.effectLogged],
        value: invitationButton.revoke(id),
        button: text.confirmRevoke,
      },
    },
    reinvite: !rebind && invitation.expired ? { label: text.reinvite, detail: t(text.reinviteDetail, { email }), value: invitationButton.reinvite(id) } : null,
  };
}

function resetOption(roster: TeamRoster, member: TeamMember): ResetOption | null {
  const effects = resetEffects(roster, member.profileId);
  if (effects === null) return null;
  const email = emailOf(member);
  const sentences: string[] = [text.effectResetAlways, text.effectResetInvitations];
  if (effects.includes("inviter")) sentences.push(text.effectResetInviter);
  if (effects.includes("alone")) sentences.push(text.effectResetAlone);
  if (effects.includes("again")) sentences.push(text.effectResetAgain);
  sentences.push(text.effectResetCode, text.effectLogged);
  return {
    id: member.profileId,
    email,
    choose: { label: text.resetChoose, detail: t(text.resetChooseDetail, { email }), value: resetButton.choose(member.profileId) },
    confirmation: {
      title: t(text.confirmResetTitle, { email }),
      effects: sentences,
      value: resetButton.confirm(member.profileId, effectsKey(effects)),
      button: text.confirmReset,
    },
  };
}

/** Lo que la pantalla del equipo pinta, a partir de lo que la base contestó. */
export function teamView(roster: TeamRoster): TeamView {
  return {
    canChange: roster.freshCode,
    capabilities: CAPABILITIES.map((capability) => ({ value: capability, label: names[capability] })),
    members: roster.members.map((member) => memberRow(roster, member)),
    invitations: roster.invitations.map((invitation) => invitationRow(roster, invitation)),
    resettable: roster.members.map((member) => resetOption(roster, member)).filter((option) => option !== null),
  };
}
