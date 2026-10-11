import "server-only";

import { z } from "zod";

import { asSystem } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import { getEnv } from "@/config/env";
import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

// Leer un texto legal para mostrarlo (RF-903; diseño PA-07). Solo los tipos que cualquiera
// puede leer sin sesión, que son los mismos que deja la política de la base
// (`legal_documents_public_select`), y solo su versión vigente.

export { legalBlocks, type LegalBlock } from "./blocks";

/** Los tipos de texto que se pueden leer sin sesión. */
const PUBLIC_DOC_TYPES: ReadonlySet<string> = new Set([
  "terms",
  "student_privacy_notice",
  "community_policy",
  "refund_policy",
  "course_history_consent",
  "recurring_charge_consent",
]);

/**
 * La dirección de cada texto que ya tiene página (`/legal/[documento]`). Los demás tipos
 * públicos reciben la suya cuando existan sus textos (T-606).
 */
export const LEGAL_SLUGS = {
  terminos: "terms",
  privacidad: "student_privacy_notice",
  "historial-de-cursos": "course_history_consent",
} as const;

const slugs = new Map<string, string>(Object.entries(LEGAL_SLUGS));

/** El tipo de texto de una dirección, o nulo si esa dirección no es de ningún texto. */
export function docTypeOfSlug(slug: string): string | null {
  return slugs.get(slug) ?? null;
}

/** La dirección de un tipo de texto, o nulo si todavía no tiene página. */
export function slugOfDocType(docType: string): string | null {
  for (const [slug, type] of slugs) if (type === docType) return slug;
  return null;
}

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
}

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
    ...overrides,
  };

  /** El texto vigente de un tipo público. Un tipo fuera de la lista no llega a la base. */
  async function currentLegalText(docType: string): Promise<LegalTextRead> {
    if (!PUBLIC_DOC_TYPES.has(docType)) return { kind: "not_found" };
    let found: z.infer<typeof row> | undefined;
    try {
      [found] = await asSystem({ reason: "legal_text_read" }, (tx) =>
        tx.query(
          sql`select d.id::text as id, d.version, d.title, d.body,
                     to_char(d.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from
              from public.legal_documents d
              where d.id = private.current_legal_document(${docType}::public.legal_doc_type)`,
          row,
        ),
      );
    } catch {
      await deps.report("legal_text_unavailable");
      return { kind: "unavailable" };
    }
    // Un borrador solo existe en una base local, y solo ahí se muestra.
    if (!found || (found.version === 0 && !deps.isLocal())) return { kind: "not_found" };
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
