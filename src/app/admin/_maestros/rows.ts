import { longDate } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { adminTeacherPath } from "@/services/account/navigation";
import type { FraudRequest, TeacherRoster, TeacherRow } from "@/services/teachers/teacher-admin";
import { teacherVersion } from "@/services/teachers/version";

import { teachersButton } from "./outcomes";

// Lo que las pantallas de los maestros pintan, ya en palabras desde la página. Decide qué se ofrece: la base vuelve a
// decidirlo al pedirlo. Es puro.

const text = admin.teachers;

type Tone = "neutral" | "active" | "attention" | "good" | "bad";

const STATUS: Record<TeacherRow["status"], { label: string; tone: Tone }> = {
  invited: { label: text.status.invited, tone: "attention" },
  active: { label: text.status.active, tone: "good" },
  suspended: { label: text.status.suspended, tone: "bad" },
  left: { label: text.status.left, tone: "neutral" },
};

export interface RosterRowView {
  id: string;
  name: string;
  href: string;
  email: string | null;
  status: { label: string; tone: Tone };
  founder: string | null;
  invitation: string | null;
  isSelf: boolean;
  /** Reenviar y revocar, si se ofrecen. */
  reinvite: string | null;
  revoke: string | null;
}

export interface RequestView {
  id: string;
  teacherHref: string;
  title: string;
  reason: string;
  proposed: string;
  metric: string;
}

export interface RosterView {
  canChange: boolean;
  rows: RosterRowView[];
  requests: RequestView[];
}

const nameOf = (name: string | null) => name ?? text.noName;

function invitationText(row: TeacherRow): string | null {
  switch (row.invitation) {
    case "pending":
      return row.expiresAt === null ? text.invitation.pending : t(text.invitation.pendingUntil, { date: longDate(row.expiresAt) });
    case "expired":
      return text.invitation.expired;
    case "revoked":
      return text.invitation.revoked;
    default:
      return null;
  }
}

function requestView(request: FraudRequest): RequestView {
  return {
    id: request.id,
    teacherHref: adminTeacherPath(request.teacherId),
    title: nameOf(request.name),
    reason: request.reason,
    proposed: t(text.fraud.proposedOn, { date: longDate(request.proposedAt) }),
    metric: t(text.fraud.metric, { metric: String(request.metric), threshold: String(request.threshold) }),
  };
}

export function rosterView(roster: TeacherRoster): RosterView {
  return {
    canChange: roster.freshCode,
    requests: roster.requests.map(requestView),
    rows: roster.teachers.map((row) => {
      const seen = teacherVersion(row);
      const open = row.status === "invited" && !row.isSelf;
      return {
        id: row.id,
        name: nameOf(row.name),
        href: adminTeacherPath(row.id),
        email: row.email,
        status: STATUS[row.status],
        founder: row.founderSince === null ? null : t(text.founderSince, { date: longDate(row.founderSince) }),
        invitation: invitationText(row),
        isSelf: row.isSelf,
        // Una revocada se puede reenviar, pero no volver a revocar.
        reinvite: open && row.invitation !== "none" ? teachersButton.reinvite(row.id, seen) : null,
        revoke: open && (row.invitation === "pending" || row.invitation === "expired") ? teachersButton.revoke(row.id, seen) : null,
      };
    }),
  };
}

export interface TeacherView {
  canChange: boolean;
  id: string;
  name: string;
  email: string | null;
  status: { label: string; tone: Tone };
  isSelf: boolean;
  founder: { since: string | null; label: string | null; save: string; clear: string | null } | null;
  suspension: { kind: string; since: string | null; reason: string | null; notice: string | null } | null;
  suspend: { ask: string; confirm: string } | null;
  lift: string | null;
  request: (RequestView & { ask: string | null; confirm: string | null; reject: string | null; blocked: string | null }) | null;
}

/** La ficha de ese maestro, o nulo si no está en la lista. */
export function teacherView(roster: TeacherRoster, id: string): TeacherView | null {
  const row = roster.teachers.find((each) => each.id === id);
  if (row === undefined) return null;
  const seen = teacherVersion(row);
  const request = roster.requests.find((each) => each.teacherId === id) ?? null;
  const blocked =
    request === null
      ? null
      : request.aboutSelf
        ? text.fraud.aboutSelf
        : request.proposedBySelf
          ? text.fraud.proposedBySelf
          : request.markedBySelf
            ? text.fraud.markedBySelf
            : null;
  const mayDecide = request !== null && blocked === null && !row.isSelf;
  return {
    canChange: roster.freshCode,
    id: row.id,
    name: nameOf(row.name),
    email: row.email,
    status: STATUS[row.status],
    isSelf: row.isSelf,
    founder: row.isSelf
      ? null
      : {
          since: row.founderSince,
          label: row.founderSince === null ? null : t(text.founderSince, { date: longDate(row.founderSince) }),
          save: teachersButton.founder(row.id, seen),
          clear: row.founderSince === null ? null : teachersButton.clearFounder(row.id, seen),
        },
    suspension:
      row.status !== "suspended"
        ? null
        : {
            kind: row.suspension === "fraud" ? text.suspension.fraud : text.suspension.manual,
            since: row.suspendedAt === null ? null : longDate(row.suspendedAt),
            reason: row.suspensionReason,
            notice: row.suspensionNotice,
          },
    suspend: row.status === "active" && !row.isSelf ? { ask: teachersButton.askSuspend(row.id, seen), confirm: teachersButton.suspend(row.id, seen) } : null,
    lift: row.status === "suspended" && !row.isSelf ? teachersButton.lift(row.id, seen) : null,
    request:
      request === null
        ? null
        : {
            ...requestView(request),
            blocked,
            ask: mayDecide ? teachersButton.askConfirm(row.id, seen, request.id) : null,
            confirm: mayDecide ? teachersButton.confirm(row.id, seen, request.id) : null,
            reject: mayDecide ? teachersButton.reject(row.id, seen, request.id) : null,
          },
  };
}
