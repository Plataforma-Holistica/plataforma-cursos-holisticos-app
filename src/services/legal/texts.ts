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
// La página que los pinta es pública: cualquiera la pide, sin sesión, las veces que quiera,
// y la reserva de conexiones es la misma con la que la gente entra. Por eso un tipo que no
// es público ni llega a la base, lo leído se recuerda unos segundos, las peticiones que
// coinciden comparten una sola lectura, y un fallo también se recuerda un momento.

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

/** Cuánto se recuerda lo leído. Un texto recién publicado tarda esto, a lo más, en verse en su página. */
export const LEGAL_TEXT_MEMORY_MS = 30_000;
/**
 * Lo menos que pasa entre dos lecturas del mismo tipo cuando alguien pide una versión más
 * nueva que la recordada. Sin esto, pedir una versión que no existe saltaría la memoria.
 */
export const LEGAL_TEXT_REREAD_MS = 1_000;
/** Cuánto se recuerda un fallo: mientras tanto no se vuelve a la base ni se reporta otra vez. */
export const LEGAL_TEXT_FAILURE_MS = 5_000;

const row = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  body: z.string(),
  effective_from: z.string(),
});

/** Lo que la base contestó por un tipo: su texto vigente, o nulo si no tiene. */
interface Entry {
  at: number;
  found: z.infer<typeof row> | null;
}

export function createLegalTexts(overrides: Partial<LegalDependencies> = {}) {
  const deps: LegalDependencies = {
    isLocal: () => getEnv().APP_ENV === "local",
    report: reportFailure,
    now: () => Date.now(),
    ...overrides,
  };
  // A lo más, una entrada por tipo público en cada uno.
  const remembered = new Map<string, Entry>();
  const failedAt = new Map<string, number>();
  const reading = new Map<string, Promise<Entry | null>>();

  /** Lee de la base, una sola vez aunque varias peticiones coincidan. Nulo si no se supo. */
  function read(docType: string): Promise<Entry | null> {
    const flying = reading.get(docType);
    if (flying) return flying;
    const attempt = (async () => {
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
        const entry = { at: deps.now(), found: found ?? null };
        remembered.set(docType, entry);
        return entry;
      } catch {
        failedAt.set(docType, deps.now());
        await deps.report("legal_text_unavailable");
        return null;
      } finally {
        reading.delete(docType);
      }
    })();
    reading.set(docType, attempt);
    return attempt;
  }

  /**
   * El texto vigente de un tipo público. Un tipo fuera de la lista no llega a la base.
   *
   * @param atLeastVersion La versión que quien pregunta ya vio anunciada: la que pinta el
   *   formulario desde el que se llega a leer. Si lo recordado es anterior, se vuelve a
   *   leer: nadie lee una versión y acepta otra porque la memoria se quedó atrás.
   */
  async function currentLegalText(docType: string, atLeastVersion?: number): Promise<LegalTextRead> {
    if (!isPublicDocType(docType)) return { kind: "not_found" };

    const now = deps.now();
    let entry = remembered.get(docType);
    const fresh = entry !== undefined && now - entry.at < LEGAL_TEXT_MEMORY_MS;
    const behind =
      entry !== undefined &&
      atLeastVersion !== undefined &&
      (entry.found?.version ?? -1) < atLeastVersion &&
      now - entry.at >= LEGAL_TEXT_REREAD_MS;
    if (!fresh || behind) {
      const failed = failedAt.get(docType);
      // Acaba de fallar: no se le pregunta otra vez a una base que no contesta.
      if (failed !== undefined && now - failed < LEGAL_TEXT_FAILURE_MS) return { kind: "unavailable" };
      const latest = await read(docType);
      if (latest === null) return { kind: "unavailable" };
      entry = latest;
    }

    const found = entry?.found ?? null;
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
