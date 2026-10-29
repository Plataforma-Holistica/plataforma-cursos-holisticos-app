import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { LEGAL_DOC_TYPES, VERSION_STATES, type LegalDocuments, type LegalVersionText, type Published, type PublishInput } from "./admin";

// Lo que PA-89 le pregunta a la base (esquema §5.8; T-110): la tabla de los nueve textos, el texto de
// una versión y publicar. Cada función recibe la transacción ya abierta como servidor; ninguna recibe
// quién actúa. Son las únicas que nombran esas tres funciones de la base.

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const docType = z.enum(LEGAL_DOC_TYPES);
const instant = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.number().int().min(0);

// Estrictos: un campo que este código no conoce no pasa.
const documentsSchema = z.strictObject({
  fresh_code: z.boolean(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  documents: z.array(
    z.strictObject({
      doc_type: docType,
      last_version: version.nullable(),
      versions: z.array(
        z.strictObject({
          id,
          version,
          title: z.string(),
          effective_from: instant,
          published_at: instant,
          body_sha256: sha,
          is_draft: z.boolean(),
          state: z.enum(VERSION_STATES),
        }),
      ),
    }),
  ),
});
const versionSchema = z.strictObject({
  fresh_code: z.boolean(),
  document: z
    .strictObject({
      id,
      doc_type: docType,
      version,
      title: z.string(),
      body: z.string(),
      effective_from: instant,
      published_at: instant,
      body_sha256: sha,
    })
    .nullable(),
});
const publishedSchema = z.discriminatedUnion("answer", [
  z.strictObject({ answer: z.literal("published"), id, version: version.min(1), effective_from: instant }),
  z.strictObject({ answer: z.literal("changed"), version: version.nullable() }),
  z.strictObject({ answer: z.enum(["forbidden", "needs_fresh_code", "invalid", "past", "unavailable"]) }),
]);

/** Las respuestas que este archivo lee: las de la lista del servicio, ni una más ni una menos (lo prueba su prueba). */
export const READ_ANSWERS: readonly string[] = publishedSchema.options.flatMap((option) => {
  const answer = option.shape.answer;
  return "options" in answer ? [...answer.options] : [answer.value];
});

/** Lo que contestó `private.legal_documents_admin()`, o nulo si contestó nulo. Otra forma lanza. */
export function documentsOf(raw: unknown): LegalDocuments | null {
  if (raw === null) return null;
  const read = documentsSchema.parse(raw);
  // Los nueve, en su orden: otra lista es otra base.
  if (read.documents.map((each) => each.doc_type).join() !== LEGAL_DOC_TYPES.join()) {
    throw new Error("La base no contestó los nueve textos legales en su orden.");
  }
  return {
    freshCode: read.fresh_code,
    today: read.today,
    documents: read.documents.map((each) => ({
      docType: each.doc_type,
      lastVersion: each.last_version,
      versions: each.versions.map((row) => ({
        id: row.id,
        version: row.version,
        title: row.title,
        effectiveFrom: row.effective_from,
        publishedAt: row.published_at,
        bodySha256: row.body_sha256,
        isDraft: row.is_draft,
        state: row.state,
      })),
    })),
  };
}

/** Lo que contestó `private.legal_document_admin()`, o nulo si contestó nulo. Otra forma lanza. */
export function versionOf(raw: unknown): { document: LegalVersionText | null } | null {
  if (raw === null) return null;
  const read = versionSchema.parse(raw);
  const row = read.document;
  return {
    document:
      row === null
        ? null
        : {
            id: row.id,
            docType: row.doc_type,
            version: row.version,
            title: row.title,
            body: row.body,
            effectiveFrom: row.effective_from,
            publishedAt: row.published_at,
            bodySha256: row.body_sha256,
          },
  };
}

/** Lo que contestó publicar. Otra forma lanza. */
export function publishedOf(raw: unknown): Published {
  const read = publishedSchema.parse(raw);
  switch (read.answer) {
    case "published":
      return { answer: "published", id: read.id, version: read.version, effectiveFrom: read.effective_from };
    case "changed":
      return { answer: "changed", version: read.version };
    default:
      return { answer: read.answer };
  }
}

const readRow = z.object({ read: z.unknown() });

export async function readLegalDocuments(tx: Tx): Promise<LegalDocuments | null> {
  const [row] = await tx.query(sql`select private.legal_documents_admin() as read`, readRow);
  if (!row) throw new Error("La base no contestó los textos legales.");
  return documentsOf(row.read);
}

export async function readLegalVersion(tx: Tx, versionId: string): Promise<{ document: LegalVersionText | null } | null> {
  const [row] = await tx.query(sql`select private.legal_document_admin(${versionId}::uuid) as read`, readRow);
  if (!row) throw new Error("La base no contestó la versión de un texto legal.");
  return versionOf(row.read);
}

/** Publica (`private.publish_legal_document()`). Devuelve lo que contestó, ya leído. */
export async function askPublish(tx: Tx, input: PublishInput): Promise<Published> {
  const [row] = await tx.query(
    sql`select private.publish_legal_document(${input.docType}::text, ${input.title}::text, ${input.body}::text,
                                              ${input.day}::date, ${input.seenVersion}::integer) as read`,
    readRow,
  );
  return publishedOf(row?.read ?? null);
}
