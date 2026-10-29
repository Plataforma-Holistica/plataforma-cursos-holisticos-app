import "server-only";

import { giveSecondFactorCode, teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createLegalAdmin } from "./admin";
import { databaseLegalStore } from "./admin-store";

// Los textos legales desde administración (PA-89), ya armados con la guarda del equipo, la base y el
// registro de errores. Lo que importan las pantallas.

export type { DocumentsRead, LegalCode, LegalDocType, LegalDocumentRow, LegalDocuments, LegalVersion, LegalVersionText, VersionPublished, VersionRead, VersionState } from "./admin";
export { LEGAL_DOC_TYPES, bodyFingerprint } from "./admin";
export { legalBlocks, type LegalBlock } from "./blocks";

export const { legalDocuments, legalVersion, publishLegalVersion, giveLegalCode } = createLegalAdmin(
  { report: reportFailure },
  { teamStanding, giveSecondFactorCode, store: databaseLegalStore },
);
