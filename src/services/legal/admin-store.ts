import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import type { LegalStore } from "./admin";
import { askPublish, readLegalDocuments, readLegalVersion } from "./admin-records";

// Lo que PA-89 le pregunta a la base, a nombre de las claims que verificó: cada pregunta abre su
// transacción como servidor, con quién actúa y con qué sesión tomados de esas claims.

/** `run` es `asServer`. Solo las pruebas de este archivo pasan otro, para ver qué se reintenta. */
export function createLegalStore(run: typeof asServer = asServer): LegalStore {
  return {
    // Solo leen y no toman candados: no hay choque que reintentar.
    documents: (claims) => run({ claims, reason: "legal_documents_admin" }, (tx) => readLegalDocuments(tx)),
    version: (claims, id) => run({ claims, reason: "legal_document_admin" }, (tx) => readLegalVersion(tx, id)),
    // Publicar toma el candado del tipo y no escribe antes de rechazar: un choque de candados revierte
    // la transacción entera, y se intenta una vez más.
    publish: (claims, input) =>
      withLockRetry(() => run({ claims, reason: "legal_publish" }, (tx) => askPublish(tx, input)), isLockConflict),
  };
}

export const databaseLegalStore = createLegalStore();
