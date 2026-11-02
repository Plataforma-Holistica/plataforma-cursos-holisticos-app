import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { TaxPayoutAnswer, TaxProfileRow, TaxProfileSeal, TaxProfileState, TaxReadAnswer, TaxSaveAnswer } from "./tax-profile";

// Lo que el servicio de los datos fiscales le pregunta a la base, como el servidor y a nombre de la persona. Las cuatro funciones de
// `t409_datos_fiscales` se nombran solo aquí. Lo cifrado viaja en base64, en una sola línea, y se abre con la transacción ya confirmada.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const payload = z
  .object({
    outcome: z.literal("ok"),
    teacher_id: z.string().regex(ID),
    version: z.number().int().min(1),
    key_version: z.number().int().min(1),
    rfc: z.string().regex(BASE64),
    legal_name: z.string().regex(BASE64),
    tax_regime_code: z.string(),
    payee_kind: z.enum(["person", "company"]),
    clabe: z.string().regex(BASE64),
    clabe_last4: z.string(),
    updated_at: z.string(),
  })
  .strict();

function rowOf(answer: z.infer<typeof payload>): TaxProfileRow {
  return {
    teacherId: answer.teacher_id,
    version: answer.version,
    regime: answer.tax_regime_code,
    payee: answer.payee_kind,
    last4: answer.clabe_last4,
    updatedAt: new Date(answer.updated_at).toISOString(),
    rfc: Buffer.from(answer.rfc, "base64"),
    legalName: Buffer.from(answer.legal_name, "base64"),
    clabe: Buffer.from(answer.clabe, "base64"),
  };
}

const answerRow = z.object({ answer: z.unknown() });

const stateAnswer = z.union([
  z
    .object({
      outcome: z.literal("ok"),
      version: z.number().int().min(0),
      updated_at: z.string().nullable(),
      can_save: z.boolean(),
      clabe_waits_until: z.string().nullable(),
      clabe_recapture: z.boolean(),
    })
    .strict(),
  z.object({ outcome: z.literal("not_teacher") }).strict(),
]);

export async function askTaxState(tx: Tx): Promise<TaxProfileState | null> {
  const rows = await tx.query(sql`select private.tax_profile_state() as answer`, answerRow);
  const answer = stateAnswer.parse(rows[0]?.answer);
  if (answer.outcome === "not_teacher") return null;
  return {
    version: answer.version,
    updatedAt: answer.updated_at === null ? null : new Date(answer.updated_at).toISOString(),
    canSave: answer.can_save,
    clabeWaitsUntil: answer.clabe_waits_until === null ? null : new Date(answer.clabe_waits_until).toISOString(),
    clabeRecapture: answer.clabe_recapture,
  };
}

const saveAnswer = z.enum(["saved", "changed", "invalid", "not_teacher", "suspended", "needs_notice"]);

export async function askTaxSave(tx: Tx, row: TaxProfileSeal): Promise<TaxSaveAnswer> {
  const rows = await tx.query(
    sql`select private.tax_profile_save(${row.teacher}::uuid, ${row.seen}::integer, ${row.rfc}::bytea, ${row.legalName}::bytea, ${row.regime}, ${row.payee},
                                         ${row.clabe}::bytea, ${row.last4}, ${row.keyVersion}::integer, ${row.clabeChanged}::boolean) as answer`,
    answerRow,
  );
  return saveAnswer.parse(rows[0]?.answer);
}

const mineAnswer = z.union([payload, z.object({ outcome: z.enum(["no_profile", "not_teacher"]) }).strict()]);

export async function askTaxMine(tx: Tx): Promise<TaxReadAnswer> {
  const rows = await tx.query(sql`select private.tax_profile_mine() as answer`, answerRow);
  const answer = mineAnswer.parse(rows[0]?.answer);
  return answer.outcome === "ok" ? { outcome: "ok", row: rowOf(answer) } : { outcome: answer.outcome };
}

const payoutAnswer = z.union([
  payload,
  z.object({ outcome: z.literal("clabe_waiting"), until: z.string() }).strict(),
  z.object({ outcome: z.enum(["forbidden", "needs_fresh_code", "not_found", "self", "no_profile", "clabe_held", "clabe_recapture"]) }).strict(),
]);

export async function askTaxForPayout(tx: Tx, payout: string): Promise<TaxPayoutAnswer> {
  const rows = await tx.query(sql`select private.tax_profile_for_payout(${payout}::uuid) as answer`, answerRow);
  const answer = payoutAnswer.parse(rows[0]?.answer);
  if (answer.outcome === "ok") return { outcome: "ok", row: rowOf(answer) };
  if (answer.outcome === "clabe_waiting") return { outcome: "clabe_waiting", until: new Date(answer.until).toISOString() };
  return { outcome: answer.outcome };
}
