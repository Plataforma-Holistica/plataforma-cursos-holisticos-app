import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { ClaimedMail } from "./outbox";

// Lo que la salida de correo le pregunta a la base, como sistema. Las cuatro funciones de `t604_salida_de_correo` se nombran solo aquí: de aquí salen direcciones.

const claimedRow = z
  .object({ id: z.string(), idempotency_key: z.string(), template: z.string(), recipient: z.string(), params: z.unknown(), attempt: z.number().int() })
  .strict();

export async function askMailClaim(tx: Tx, limit: number): Promise<ClaimedMail[]> {
  const rows = await tx.query(sql`select id, idempotency_key, template, recipient, params, attempt from private.mail_claim(${limit}::integer)`, claimedRow);
  return rows.map((row) => ({ id: row.id, key: row.idempotency_key, template: row.template, recipient: row.recipient, params: row.params, attempt: row.attempt }));
}

export async function askMailSent(tx: Tx, id: string): Promise<void> {
  await tx.query(sql`select private.mail_sent(${id}::uuid) as answer`, z.object({ answer: z.boolean() }));
}

export async function askMailRejected(tx: Tx, id: string, attempt: number): Promise<void> {
  await tx.query(sql`select private.mail_rejected(${id}::uuid, ${attempt}::integer) as answer`, z.object({ answer: z.boolean() }));
}

const healthRow = z.object({ answer: z.object({ failed: z.number().int(), overdue: z.number().int() }).strict() });

export async function askMailHealth(tx: Tx): Promise<{ failed: number; overdue: number }> {
  const rows = await tx.query(sql`select private.mail_health() as answer`, healthRow);
  const row = rows[0];
  if (row === undefined) throw new Error("mail_health no contestó");
  return row.answer;
}
