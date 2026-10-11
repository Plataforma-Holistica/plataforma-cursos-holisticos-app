import "server-only";

import { z } from "zod";

import { asSystem } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import { getEnv } from "@/config/env";
import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import { isPublicDocType } from "./slugs";

// Leer un texto legal para mostrarlo (RF-903; diseño PA-07). Solo los tipos que cualquiera
// puede leer sin sesión, y solo su versión vigente.
//
// La página que los pinta es pública: cualquiera la pide, sin sesión, las veces que quiera.
// Por eso lo leído se recuerda unos segundos, y un tipo que no es público ni llega a la
// base: la reserva de conexiones es la misma con la que la gente entra.

export { legalBlocks, type LegalBlock } from "./blocks";
export { docTypeOfSlug, LEGAL_SLUGS, PUBLIC_DOC_TYPES, slugOfDocType } from "./slugs";

export interface PublishedText {
  docType: string;
  documentId: string;
  version: number;
  title: string;
  body: string;
  /** Desde cuándo rige, en UTC y en formato ISO. */
  effectiveFrom: string;
}

export type LegalTextRead =
  | { kind: "found"; text: PublishedText }
  /** Ese tipo no es público, no existe, o no tiene texto vigente. */
  | { kind: "not_found" }
  /** No se supo. */
  | { kind: "unavailable" };

export interface LegalDependencies {
  /** Corre en local: ahí un borrador (versión 0) vale como texto vigente. */
  isLocal: () => boolean;
  report: (code: FailureCode) => Promise<void>;
  /** El reloj de lo recordado, en milisegundos. */
  now: () => number;
}

/**
 * Cuánto se recuerda lo leído. Un texto recién publicado tarda esto, a lo más, en verse en
 * su página. A nadie le hace aceptar un texto viejo: lo que se acepta se compara con el
 * vigente al enviar (`matchAccepted`), en la base.
 */
export const LEGAL_TEXT_MEMORY_MS = 30_000;

const row = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  body: z.string(),
  effective_from: z.string(),
});

export function createLegalTexts(overrides: Partial<LegalDependencies> = {}) {
  const deps: LegalDependencies = {
    isLocal: () => getEnv().APP_ENV === "local",
    report: reportFailure,
    now: () => Date.now(),
    ...overrides,
  };
  // Lo que la base contestó por tipo: el texto vigente, o nulo si no tiene. A lo más, una
  // entrada por tipo público. Un «no se supo» no se recuerda.
  const remembered = new Map<string, { at: number; found: z.infer<typeof row> | null }>();

  /** El texto vigente de un tipo público. Un tipo fuera de la lista no llega a la base. */
  async function currentLegalText(docType: string): Promise<LegalTextRead> {
    if (!isPublicDocType(docType)) return { kind: "not_found" };

    let entry = remembered.get(docType);
    if (entry === undefined || deps.now() - entry.at >= LEGAL_TEXT_MEMORY_MS) {
      try {
        const [found] = await asSystem({ reason: "legal_text_read" }, (tx) =>
          tx.query(
            sql`select d.id::text as id, d.version, d.title, d.body,
                       to_char(d.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from
                from public.legal_documents d
                where d.id = private.current_legal_document(${docType}::public.legal_doc_type)`,
            row,
          ),
        );
        entry = { at: deps.now(), found: found ?? null };
        remembered.set(docType, entry);
      } catch {
        await deps.report("legal_text_unavailable");
        return { kind: "unavailable" };
      }
    }

    const { found } = entry;
    // Un borrador solo existe en una base local, y solo ahí se muestra.
    if (found === null || (found.version === 0 && !deps.isLocal())) return { kind: "not_found" };
    return {
      kind: "found",
      text: {
        docType,
        documentId: found.id,
        version: found.version,
        title: found.title,
        body: found.body,
        effectiveFrom: found.effective_from,
      },
    };
  }

  return { currentLegalText };
}

export const { currentLegalText } = createLegalTexts();
