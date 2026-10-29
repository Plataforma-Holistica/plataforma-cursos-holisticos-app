import { longDate } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { legalVersionPath } from "@/services/account/navigation";
import type { LegalDocType, LegalDocuments, LegalVersion, VersionState } from "@/services/legal/legal-admin";

// Lo que PA-89 pinta de la base, ya en palabras (T-110): el navegador no necesita saber leer fechas, y se ve
// lo mismo con JavaScript y sin él. Es puro.

const text = admin.legal;

/** El nombre de cada tipo, del catálogo. */
const DOC_NAMES: Record<LegalDocType, string> = {
  terms: text.names.terms,
  student_privacy_notice: text.names.studentPrivacyNotice,
  teacher_privacy_notice: t(text.names.teacherPrivacyNotice),
  community_policy: text.names.communityPolicy,
  refund_policy: text.names.refundPolicy,
  teacher_agreement: t(text.names.teacherAgreement),
  license_annex: text.names.licenseAnnex,
  course_history_consent: text.names.courseHistoryConsent,
  recurring_charge_consent: text.names.recurringChargeConsent,
};

export function docName(docType: LegalDocType): string {
  return DOC_NAMES[docType];
}

export interface VersionView {
  id: string;
  label: string;
  state: VersionState;
  stateText: string;
  since: string;
  href: string;
}

export interface DocumentView {
  docType: LegalDocType;
  name: string;
  /** Lo que rige hoy, en una frase. */
  current: string;
  /** Las programadas que todavía pueden regir, en una frase cada una. */
  scheduled: string[];
  versions: VersionView[];
  /** La última versión que hay: la que se manda como vista al publicar. */
  lastVersion: number | null;
  /** El título con que se arma una versión nueva: el de la última. */
  lastTitle: string;
}

export interface LegalView {
  /** Publicar pasaría hoy la puerta sin pedir el código otra vez. */
  canChange: boolean;
  /** Hoy en la zona del periodo, o nulo si falta el parámetro: entonces no se ofrece publicar. */
  today: string | null;
  documents: DocumentView[];
}

const STATE_TEXT: Record<VersionState, string> = {
  current: text.states.current,
  scheduled: text.states.scheduled,
  superseded: text.states.superseded,
  previous: text.states.previous,
};

function currentText(versions: readonly LegalVersion[]): string {
  const current = versions.find((each) => each.state === "current");
  if (current === undefined) return text.none;
  if (current.isDraft) return text.currentDraft;
  return t(text.current, { version: current.version, date: longDate(current.effectiveFrom) });
}

export function legalView(read: LegalDocuments): LegalView {
  return {
    canChange: read.freshCode,
    today: read.today,
    documents: read.documents.map((row) => ({
      docType: row.docType,
      name: docName(row.docType),
      current: currentText(row.versions),
      scheduled: row.versions
        .filter((each) => each.state === "scheduled")
        .map((each) => t(text.scheduled, { version: each.version, date: longDate(each.effectiveFrom) }))
        .reverse(),
      versions: row.versions.map((each) => ({
        id: each.id,
        label: t(text.versionLabel, { version: each.version }),
        state: each.state,
        stateText: each.isDraft ? `${STATE_TEXT[each.state]} · ${text.draft}` : STATE_TEXT[each.state],
        since: t(text.since, { date: longDate(each.effectiveFrom) }),
        href: legalVersionPath(each.id),
      })),
      lastVersion: row.lastVersion,
      lastTitle: row.versions[0]?.title ?? docName(row.docType),
    })),
  };
}

/**
 * El aviso de lo publicado viaja en una cookie sin texto ni versión: se pinta solo si alguna versión se
 * publicó hace menos de lo que dura la cookie.
 */
export function acceptedPublishedNotice(read: LegalDocuments, now: string, maxAgeSeconds: number): boolean {
  const at = Date.parse(now);
  return read.documents.some((row) =>
    row.versions.some((each) => {
      const published = Date.parse(each.publishedAt);
      return !Number.isNaN(published) && at - published >= 0 && at - published <= maxAgeSeconds * 1000;
    }),
  );
}
