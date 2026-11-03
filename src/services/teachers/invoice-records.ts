import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql, type SqlQuery } from "@/adapters/supabase/sql";

import type { InvoiceBeginAnswer, InvoiceFileAnswer, InvoiceReviewAnswer, InvoiceSeal, InvoiceSubmitAnswer } from "./invoices";

// Lo que el servicio de facturas le pregunta a la base, como el servidor y a nombre de la persona (T-604). Las funciones de `t604_factura` se nombran
// solo aquí. El XML viaja cifrado, en base64 y en una sola línea, y se abre con la transacción ya confirmada.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const answerRow = z.object({ answer: z.unknown() });

async function ask(tx: Tx, query: SqlQuery): Promise<unknown> {
  const rows = await tx.query(query, answerRow);
  return rows[0]?.answer;
}

const beginAnswer = z.union([
  z.object({ outcome: z.literal("begun"), invoice_id: z.string().regex(ID), path: z.string(), expires_at: z.string() }).strict(),
  z.object({ outcome: z.enum(["not_teacher", "not_found", "changed", "not_awaiting", "receiver_missing", "already_in_progress", "throttled"]) }).strict(),
]);

export async function askInvoiceBegin(tx: Tx, payout: string, seen: string): Promise<InvoiceBeginAnswer> {
  const answer = beginAnswer.parse(await ask(tx, sql`select private.invoice_begin(${payout}::uuid, ${seen}) as answer`));
  if (answer.outcome !== "begun") return { outcome: answer.outcome };
  return { outcome: "begun", invoice: answer.invoice_id, path: answer.path, expiresAt: new Date(answer.expires_at).toISOString() };
}

const uploadAnswer = z.union([
  z.object({ outcome: z.literal("ok"), path: z.string(), payout_id: z.string().regex(ID), status: z.enum(["uploading", "in_review", "accepted", "rejected"]) }).strict(),
  z.object({ outcome: z.literal("not_found") }).strict(),
]);

/** A dónde subió su maestro y en qué va su factura. Nulo si no es suya. */
export async function askInvoiceUpload(tx: Tx, invoice: string): Promise<{ path: string; payout: string; status: string } | null> {
  const answer = uploadAnswer.parse(await ask(tx, sql`select private.invoice_upload(${invoice}::uuid) as answer`));
  return answer.outcome === "ok" ? { path: answer.path, payout: answer.payout_id, status: answer.status } : null;
}

const submitAnswer = z.union([
  z.object({ outcome: z.literal("submitted"), invoice_id: z.string().regex(ID) }).strict(),
  z.object({ outcome: z.literal("amounts_mismatch"), fields: z.array(z.enum(["subtotal_cents", "vat_cents", "income_tax_withheld_cents", "vat_withheld_cents", "total_cents"])) }).strict(),
  z
    .object({
      outcome: z.enum([
        "not_teacher", "not_found", "already_submitted", "expired", "changed", "not_uploaded", "unavailable", "pdf_invalid", "malformed",
        "profile_changed", "receiver_missing", "issuer_mismatch", "regime_mismatch", "receiver_mismatch", "duplicate_cfdi",
      ]),
    })
    .strict(),
]);

export async function askInvoiceSubmit(tx: Tx, seal: InvoiceSeal): Promise<InvoiceSubmitAnswer> {
  const f = seal.facts;
  const facts = {
    uuid: f.uuid, series: f.series, folio: f.folio, issued_at: f.issuedAt, stamped_at: f.stampedAt, issuer_regime: f.issuerRegime,
    receiver_rfc: f.receiverRfc, receiver_regime: f.receiverRegime, use: f.use, payment_method: f.paymentMethod,
    subtotal_cents: f.subtotalCents, vat_cents: f.vatCents, income_tax_withheld_cents: f.incomeTaxWithheldCents, vat_withheld_cents: f.vatWithheldCents,
    total_cents: f.totalCents,
  };
  const answer = submitAnswer.parse(
    await ask(
      tx,
      sql`select private.invoice_submit(${seal.invoice}::uuid, ${seal.xml}::bytea, decode(${seal.sha256}, 'hex'), ${JSON.stringify(facts)}::jsonb,
                                        ${seal.issuerMatches}::boolean, ${seal.profileVersion}::integer, ${seal.pdfOk}::boolean) as answer`,
    ),
  );
  if (answer.outcome === "submitted") return { outcome: "submitted" };
  if (answer.outcome === "amounts_mismatch") return { outcome: "amounts_mismatch", fields: answer.fields };
  return { outcome: answer.outcome };
}

const cancelAnswer = z.object({ outcome: z.enum(["cancelled", "not_teacher", "not_found", "not_uploading"]) }).strict();

export async function askInvoiceCancel(tx: Tx, invoice: string): Promise<"cancelled" | "not_teacher" | "not_found" | "not_uploading"> {
  return cancelAnswer.parse(await ask(tx, sql`select private.invoice_cancel(${invoice}::uuid) as answer`)).outcome;
}

const reviewAnswer = z
  .object({
    outcome: z.enum([
      "accepted", "rejected", "forbidden", "needs_fresh_code", "malformed", "not_found", "self", "not_in_review", "on_hold", "changed", "receiver_changed",
    ]),
  })
  .strict();

export async function askInvoiceReview(tx: Tx, invoice: string, decision: { accept: true } | { accept: false; reason: string }): Promise<InvoiceReviewAnswer> {
  const query = decision.accept
    ? sql`select private.invoice_accept(${invoice}::uuid) as answer`
    : sql`select private.invoice_reject(${invoice}::uuid, ${decision.reason}) as answer`;
  return reviewAnswer.parse(await ask(tx, query)).outcome;
}

const fileAnswer = z.union([
  z.object({ outcome: z.literal("ok"), path: z.string(), object_version: z.string() }).strict(),
  z.object({ outcome: z.literal("ok"), teacher_id: z.string().regex(ID), xml: z.string().regex(BASE64) }).strict(),
  z.object({ outcome: z.enum(["malformed", "not_found", "self", "file_changed", "forbidden", "needs_fresh_code"]) }).strict(),
]);

export async function askInvoiceFile(tx: Tx, invoice: string, kind: "pdf" | "xml"): Promise<InvoiceFileAnswer> {
  const answer = fileAnswer.parse(await ask(tx, sql`select private.invoice_file(${invoice}::uuid, ${kind}) as answer`));
  if (answer.outcome !== "ok") return { outcome: answer.outcome };
  if ("path" in answer) return { outcome: "pdf", path: answer.path, version: answer.object_version };
  return { outcome: "xml", teacher: answer.teacher_id, xml: Buffer.from(answer.xml, "base64") };
}

const pathsRow = z.object({ path: z.string() });

/** Lo que la cubeta guarda en la carpeta de esa liquidación y ninguna fila nombra. */
export async function askInvoiceUnused(tx: Tx, payout: string): Promise<string[]> {
  const rows = await tx.query(sql`select path from private.invoice_unused_objects(${payout}::uuid)`, pathsRow);
  return rows.map((row) => row.path);
}
