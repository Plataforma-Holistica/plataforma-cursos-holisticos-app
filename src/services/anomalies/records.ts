import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import {
  AGE_TIERS,
  ALERT_KINDS,
  EXCLUDE_ANSWERS,
  EXCLUSION_REASONS,
  EXCLUSION_SCOPES,
  REVIEW_ANSWERS,
  REVOKE_ANSWERS,
  SHARE_TIERS,
  type ExcludeAnswer,
  type ExclusionReason,
  type FinanceAlerts,
  type ReviewAnswer,
  type RevokeAnswer,
} from "./alerts";

// Lo que el servicio de las alertas le pregunta a la base (05 §5.4; T-208): la lectura de PA-68 y
// las tres decisiones. Cada función recibe la transacción ya abierta como servidor; ninguna recibe
// quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);
const account = z.string().regex(/^[0-9a-f]{12}$/);
// La base da los números de `numeric` como números de JSON.
const amount = z.number().finite();

// Estrictos: un campo que este código no conoce no pasa. Así un identificador de una persona que
// alguien agregue a la función de la base no llega a la pantalla sin que esto cambie a la vista.
const alertsSchema = z.strictObject({
  fresh_code: z.boolean(),
  total: z.number().int().min(0),
  alerts: z.array(
    z.strictObject({
      id,
      period: z.number().int(),
      kind: z.enum(ALERT_KINDS),
      status: z.enum(["open", "reviewed"]),
      metric: amount,
      threshold: amount,
      today: amount.nullable(),
      details: z.record(z.string(), z.unknown()),
      detected_at: z.string(),
      review_note: z.string().nullable(),
      is_fraud: z.boolean().nullable(),
      evidence: z.string().nullable(),
      reviewed_at: z.string().nullable(),
      reviewed_by_name: z.string().nullable(),
      teacher_name: z.string().nullable(),
      can_exclude: z.boolean(),
      accounts: z.array(
        z.strictObject({
          account,
          age: z.enum(AGE_TIERS),
          share: z.enum(SHARE_TIERS).nullable(),
          half_points: z.number().int().nullable(),
          half_points_before: z.number().int().nullable(),
          lessons: z.number().int().min(0),
          covered_seconds: z.number().int().min(0).nullable(),
          excluded: z.boolean(),
        }),
      ),
      more_accounts: z.number().int().min(0),
      exclusions: z.array(
        z.strictObject({
          id,
          account,
          scope: z.enum(EXCLUSION_SCOPES),
          reason_code: z.enum(EXCLUSION_REASONS),
          reason: z.string(),
          created_by_name: z.string().nullable(),
          created_at: z.string(),
          revoked_at: z.string().nullable(),
          revoked_by_name: z.string().nullable(),
          revoke_reason: z.string().nullable(),
        }),
      ),
    }),
  ),
});

/** Lo que contestó `private.finance_alerts()`, o nulo si contestó nulo. Otra forma lanza. */
export function alertsOf(raw: unknown): FinanceAlerts | null {
  if (raw === null) return null;
  const read = alertsSchema.parse(raw);
  return {
    freshCode: read.fresh_code,
    total: read.total,
    alerts: read.alerts.map((alert) => ({
      id: alert.id,
      period: alert.period,
      kind: alert.kind,
      status: alert.status,
      metric: alert.metric,
      threshold: alert.threshold,
      today: alert.today,
      details: alert.details,
      detectedAt: alert.detected_at,
      reviewNote: alert.review_note,
      isFraud: alert.is_fraud,
      evidence: alert.evidence,
      reviewedAt: alert.reviewed_at,
      reviewedByName: alert.reviewed_by_name,
      teacherName: alert.teacher_name,
      canExclude: alert.can_exclude,
      accounts: alert.accounts.map((each) => ({
        account: each.account,
        age: each.age,
        share: each.share,
        halfPoints: each.half_points,
        halfPointsBefore: each.half_points_before,
        lessons: each.lessons,
        coveredSeconds: each.covered_seconds,
        excluded: each.excluded,
      })),
      moreAccounts: alert.more_accounts,
      exclusions: alert.exclusions.map((each) => ({
        id: each.id,
        account: each.account,
        scope: each.scope,
        reasonCode: each.reason_code,
        reason: each.reason,
        createdByName: each.created_by_name,
        createdAt: each.created_at,
        revokedAt: each.revoked_at,
        revokedByName: each.revoked_by_name,
        revokeReason: each.revoke_reason,
      })),
    })),
  };
}

/** La respuesta de una decisión, si está en su lista. Otra lanza: no se pinta como hecha. */
function answerIn<Answer extends string>(list: readonly Answer[], raw: unknown): Answer {
  const found = list.find((each) => each === raw);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}
export const reviewAnswerOf = (raw: unknown): ReviewAnswer => answerIn(REVIEW_ANSWERS, raw);
export const excludeAnswerOf = (raw: unknown): ExcludeAnswer => answerIn(EXCLUDE_ANSWERS, raw);
export const revokeAnswerOf = (raw: unknown): RevokeAnswer => answerIn(REVOKE_ANSWERS, raw);

const alertsRow = z.object({ alerts: z.unknown() });
const outcomeRow = z.object({ outcome: z.string().nullable() });

export async function readFinanceAlerts(tx: Tx): Promise<FinanceAlerts | null> {
  const [row] = await tx.query(sql`select private.finance_alerts() as alerts`, alertsRow);
  if (!row) throw new Error("La base no contestó las alertas.");
  return alertsOf(row.alerts);
}

/** Revisa, o decide fraude (`private.review_alert()`). Devuelve lo que contestó, sin juzgarlo. */
export async function askReview(tx: Tx, alertId: string, note: string | null, isFraud: boolean | null, evidence: string | null): Promise<unknown> {
  const [row] = await tx.query(
    sql`select private.review_alert(${alertId}::uuid, ${note}::text, ${isFraud}::boolean, ${evidence}::text) ->> 'outcome' as outcome`,
    outcomeRow,
  );
  return row?.outcome ?? null;
}

/** Excluye una cuenta de una alerta por su huella (`private.exclude_alert_account()`). */
export async function askExclude(tx: Tx, alertId: string, accountToken: string, reasonCode: ExclusionReason, reason: string): Promise<unknown> {
  const [row] = await tx.query(
    sql`select private.exclude_alert_account(${alertId}::uuid, ${accountToken}::text, ${reasonCode}::text, ${reason}::text) ->> 'outcome' as outcome`,
    outcomeRow,
  );
  return row?.outcome ?? null;
}

/** Revierte una exclusión (`private.revoke_exclusion()`). */
export async function askRevoke(tx: Tx, exclusionId: string, reason: string): Promise<unknown> {
  const [row] = await tx.query(sql`select private.revoke_exclusion(${exclusionId}::uuid, ${reason}::text) ->> 'outcome' as outcome`, outcomeRow);
  return row?.outcome ?? null;
}
