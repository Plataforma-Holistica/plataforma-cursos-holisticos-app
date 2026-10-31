import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { INVITATION_STATES, TEACHER_STATUSES, type TeacherRoster } from "./admin";

// Lo que el servicio de administrar maestros le pregunta a la base (esquema §6.2): la lista y la cola para las
// pantallas, y los cambios. Cada función recibe la transacción ya abierta como servidor; ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);

// Estrictos: un campo que este código no conoce no pasa.
const rosterSchema = z.strictObject({
  fresh_code: z.boolean(),
  teachers: z.array(
    z.strictObject({
      teacher_id: id,
      display_name: z.string().nullable(),
      slug: z.string().nullable(),
      status: z.enum(TEACHER_STATUSES),
      is_founder: z.boolean(),
      founder_since: z.string().nullable(),
      email: z.string().nullable(),
      invitation: z.enum(INVITATION_STATES),
      invited_at: z.string().nullable(),
      expires_at: z.string().nullable(),
      suspension: z.enum(["fraud", "manual"]).nullable(),
      suspended_at: z.string().nullable(),
      suspension_reason: z.string().nullable(),
      suspension_notice: z.string().nullable(),
      fraud_pending: z.boolean(),
      has_tax_data: z.boolean(),
      is_self: z.boolean(),
    }),
  ),
});
const queueSchema = z.strictObject({
  requests: z.array(
    z.strictObject({
      request_id: id,
      alert_id: id,
      teacher_id: id,
      display_name: z.string().nullable(),
      teacher_status: z.enum(TEACHER_STATUSES),
      reason: z.string(),
      proposed_at: z.string(),
      proposed_by_self: z.boolean(),
      marked_by_self: z.boolean(),
      alert_period: z.number().int(),
      alert_metric: z.number(),
      alert_threshold: z.number(),
    }),
  ),
});

/** Lo que contestaron `private.teacher_roster()` y la cola, o nulo si alguna contestó nulo. Otra forma lanza. */
export function rosterOf(rawRoster: unknown, rawQueue: unknown): TeacherRoster | null {
  if (rawRoster === null || rawQueue === null) return null;
  const roster = rosterSchema.parse(rawRoster);
  const queue = queueSchema.parse(rawQueue);
  return {
    freshCode: roster.fresh_code,
    teachers: roster.teachers.map((row) => ({
      id: row.teacher_id,
      name: row.display_name,
      status: row.status,
      founderSince: row.founder_since,
      email: row.email,
      invitation: row.invitation,
      expiresAt: row.expires_at,
      suspension: row.suspension,
      suspendedAt: row.suspended_at,
      suspensionReason: row.suspension_reason,
      suspensionNotice: row.suspension_notice,
      fraudPending: row.fraud_pending,
      isSelf: row.is_self,
      hasTaxData: row.has_tax_data,
    })),
    requests: queue.requests.map((row) => ({
      id: row.request_id,
      teacherId: row.teacher_id,
      name: row.display_name,
      reason: row.reason,
      proposedAt: row.proposed_at,
      proposedBySelf: row.proposed_by_self,
      markedBySelf: row.marked_by_self,
      period: row.alert_period,
      metric: row.alert_metric,
      threshold: row.alert_threshold,
    })),
  };
}

const rosterRow = z.object({ roster: z.unknown(), queue: z.unknown() });
const answerRow = z.object({ answer: z.string() });

/** La lista y la cola, en una sola consulta: una foto. */
export async function readTeacherRoster(tx: Tx): Promise<TeacherRoster | null> {
  const [row] = await tx.query(sql`select private.teacher_roster() as roster, private.fraud_suspension_queue() as queue`, rosterRow);
  return row === undefined ? null : rosterOf(row.roster ?? null, row.queue ?? null);
}

/** Lo que contestó la base, si está en la lista cerrada de esa función. Otra cosa lanza: «no se supo». */
export function teacherAnswerOf<Answer extends string>(list: readonly Answer[], answer: string): Answer {
  const known = list.find((each) => each === answer);
  if (known === undefined) throw new Error("La base contestó algo fuera de la lista.");
  return known;
}

async function answerOf(tx: Tx, query: ReturnType<typeof sql>): Promise<string> {
  const [row] = await tx.query(query, answerRow);
  if (row === undefined) throw new Error("La base no contestó.");
  return row.answer;
}

export const askInviteTeacher = (tx: Tx, name: string, email: string) => answerOf(tx, sql`select private.invite_teacher(${name}, ${email}) as answer`);
export const askReinvite = (tx: Tx, teacher: string) => answerOf(tx, sql`select private.reinvite_teacher(${teacher}::uuid) as answer`);
export const askRevokeTeacherInvitation = (tx: Tx, teacher: string) => answerOf(tx, sql`select private.revoke_teacher_invitation(${teacher}::uuid) as answer`);
export const askFounder = (tx: Tx, teacher: string, since: string | null) =>
  answerOf(tx, sql`select private.set_teacher_founder(${teacher}::uuid, ${since}::date) as answer`);
export const askSuspend = (tx: Tx, teacher: string, reason: string, notice: string) =>
  answerOf(tx, sql`select private.suspend_teacher(${teacher}::uuid, ${reason}, ${notice}) as answer`);
export const askLift = (tx: Tx, teacher: string) => answerOf(tx, sql`select private.lift_teacher_suspension(${teacher}::uuid) as answer`);
export const askDecide = (tx: Tx, request: string, confirm: boolean, note: string | null, notice: string | null) =>
  answerOf(tx, sql`select private.decide_fraud_suspension(${request}::uuid, ${confirm}, ${note}, ${notice}) as answer`);
