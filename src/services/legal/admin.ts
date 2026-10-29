import "server-only";

import { createHash } from "node:crypto";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { isCalendarDay, parseLegalBody, parseLegalTitle } from "@/domain/legal/version";

import { holds, type CodeGiven, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

// Los textos legales desde administración (RF-713, RF-108; PA-89, FL-57; T-110). Publica solo alguien
// del equipo con configuración y un código del segundo factor reciente: lo decide la base, con la
// puerta de los parámetros (`private.team_change_gate()`), y es también la base la que pone la
// versión, compara la que se vio, traduce el día a la zona del periodo y decide quién vuelve a
// aceptar. Aquí se decide a quién se le pregunta qué y en qué orden, como en las listas del catálogo:
//
//   · La guarda va primero, siempre: `teamStanding`, y solo sigue quien es del equipo con
//     configuración. Los demás reciben `refused`, sin preguntarle nada más a la base. Si no se supo
//     quién pide, `unavailable`.
//   · Lo que llega se revisa antes de tocar la base, con las reglas del dominio. Lo que no tiene forma
//     no llega (`malformed`).
//   · Publicar lleva la huella del texto que se vio en la vista previa: si el texto que llega ya no es
//     ese, no se publica (`preview_stale`). Así nadie publica algo distinto de lo que revisó.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra la lista cerrada de su
//     función. Otra cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.

/** Los nueve tipos que publica PA-89, en el orden del tipo de la base (decisión de Sergio del 2026-10-28). */
export const LEGAL_DOC_TYPES = [
  "terms",
  "student_privacy_notice",
  "teacher_privacy_notice",
  "community_policy",
  "refund_policy",
  "teacher_agreement",
  "license_annex",
  "course_history_consent",
  "recurring_charge_consent",
] as const;
export type LegalDocType = (typeof LEGAL_DOC_TYPES)[number];

/** Lo que vale una versión hoy. `superseded`: una más nueva rige desde antes, y esta no regirá (o no rigió). */
export const VERSION_STATES = ["current", "scheduled", "superseded", "previous"] as const;
export type VersionState = (typeof VERSION_STATES)[number];

export interface LegalVersion {
  id: string;
  version: number;
  title: string;
  /** Instantes como los da la base (ISO 8601). */
  effectiveFrom: string;
  publishedAt: string;
  bodySha256: string;
  isDraft: boolean;
  state: VersionState;
}
export interface LegalDocumentRow {
  docType: LegalDocType;
  /** La última versión publicada o cargada, o nula si no hay ninguna. Es la que se manda como vista. */
  lastVersion: number | null;
  /** De la más nueva a la más vieja. */
  versions: LegalVersion[];
}
export interface LegalDocuments {
  /** Publicar pasaría hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  /** Hoy en la zona del periodo (`AAAA-MM-DD`), o nulo si falta el parámetro: entonces no se publica. */
  today: string | null;
  documents: LegalDocumentRow[];
}
export interface LegalVersionText {
  id: string;
  docType: LegalDocType;
  version: number;
  title: string;
  body: string;
  effectiveFrom: string;
  publishedAt: string;
  bodySha256: string;
}

/** Lo que contesta `private.publish_legal_document()`. */
export const PUBLISH_ANSWERS = ["forbidden", "needs_fresh_code", "invalid", "past", "unavailable", "changed", "published"] as const;
export type PublishAnswer = (typeof PUBLISH_ANSWERS)[number];
export type Published =
  | { answer: "published"; id: string; version: number; effectiveFrom: string }
  /** Alguien publicó antes: `version` es la última que hay ahora. */
  | { answer: "changed"; version: number | null }
  | { answer: Exclude<PublishAnswer, "published" | "changed"> };

export interface PublishInput {
  docType: LegalDocType;
  title: string;
  body: string;
  /** `AAAA-MM-DD`, de la zona del periodo. */
  day: string;
  seenVersion: number | null;
}

/**
 * Lo que estos servicios le preguntan a la base, a nombre de las claims que se les pasan. Las lecturas
 * son nulas cuando quien actúa no pasa la puerta del equipo con configuración. Publicar lanza si la
 * base no contestó algo de su lista: quien llama lo trata como «no se supo».
 */
export interface LegalStore {
  documents(claims: VerifiedClaims): Promise<LegalDocuments | null>;
  version(claims: VerifiedClaims, id: string): Promise<{ document: LegalVersionText | null } | null>;
  publish(claims: VerifiedClaims, input: PublishInput): Promise<Published>;
}

interface Refused {
  kind: "refused";
}
interface Unavailable {
  kind: "unavailable";
}
interface Unknown {
  kind: "unknown";
}
interface Malformed {
  kind: "malformed";
}

export type DocumentsRead = { kind: "documents"; documents: LegalDocuments } | Unavailable;
export type VersionRead = { kind: "version"; text: LegalVersionText } | { kind: "not_found" } | Unavailable;
export type VersionPublished =
  | Refused
  | Unavailable
  | Unknown
  | Malformed
  /** El texto que llegó no es el de la vista previa: no se publicó. */
  | { kind: "preview_stale" }
  | ({ kind: "answered" } & Published);
/** Dar el código otra vez para que publicar pase su puerta (el bloque «Tu código»). */
export type LegalCode =
  | Refused
  | Unavailable
  | { kind: "verified" }
  | { kind: "wrong_code" }
  | { kind: "throttled" }
  | { kind: "not_available" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/** La huella de un texto como la calcula la base: SHA-256 de su UTF-8, en hexadecimal. */
export function bodyFingerprint(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function docTypeOf(value: unknown): LegalDocType | null {
  return LEGAL_DOC_TYPES.find((type) => type === value) ?? null;
}

/** Un identificador con forma, o nulo. Solo minúsculas: así dos iguales se escriben igual. */
function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/** La versión vista: nula (no había ninguna) o un entero de 0 en adelante. Otra cosa, `undefined`. */
function seenOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export interface LegalCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  /** Dar el código del segundo factor (`team.ts`): el factor es el que dice la base. */
  giveSecondFactorCode: (jar: CookieJar, code: string) => Promise<CodeGiven>;
  store: LegalStore;
}

export function createLegalAdmin(deps: { report: (code: FailureCode) => Promise<void> }, core: LegalCore) {
  const { store } = core;

  /** Quien pide, si es del equipo con configuración y su sesión pasa la puerta. */
  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "config")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /**
   * Los nueve textos, para la sección que ya pasó su guarda, con las claims que esa guarda dio. Leer
   * no pide el código reciente. Una lectura nula (la sesión dejó de pasar entre la guarda y esta
   * lectura) o que no se pudo hacer es «no se supo»; solo la segunda se reporta.
   */
  async function legalDocuments(claims: VerifiedClaims): Promise<DocumentsRead> {
    try {
      const documents = await store.documents(claims);
      return documents === null ? { kind: "unavailable" } : { kind: "documents", documents };
    } catch {
      await deps.report("legal_documents_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** El texto de una versión, por su identificador, para la sección que ya pasó su guarda. */
  async function legalVersion(claims: VerifiedClaims, id: unknown): Promise<VersionRead> {
    const versionId = idOf(id);
    if (versionId === null) return { kind: "not_found" };
    try {
      const read = await store.version(claims, versionId);
      if (read === null) return { kind: "unavailable" };
      return read.document === null ? { kind: "not_found" } : { kind: "version", text: read.document };
    } catch {
      await deps.report("legal_documents_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Publicar una versión nueva. `seenSha` es la huella del texto de la vista previa; `seenVersion`, la
   * última versión del tipo que se vio (nula si no había ninguna).
   */
  async function publishLegalVersion(
    reader: CookieReader,
    input: { docType: unknown; title: unknown; body: unknown; day: unknown; seenVersion: unknown; seenSha: unknown },
  ): Promise<VersionPublished> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const docType = docTypeOf(input.docType);
    const title = typeof input.title === "string" ? parseLegalTitle(input.title) : null;
    const body = typeof input.body === "string" ? parseLegalBody(input.body) : null;
    const day = typeof input.day === "string" && isCalendarDay(input.day) ? input.day : null;
    const seenVersion = seenOf(input.seenVersion);
    const seenSha = typeof input.seenSha === "string" && SHA.test(input.seenSha) ? input.seenSha : null;
    if (docType === null || !title?.ok || !body?.ok || day === null || seenVersion === undefined || seenSha === null) {
      return { kind: "malformed" };
    }
    if (bodyFingerprint(body.body) !== seenSha) return { kind: "preview_stale" };

    let published: Published;
    try {
      published = await store.publish(admitted.claims, { docType, title: title.title, body: body.body, day, seenVersion });
    } catch {
      await deps.report("legal_change_unavailable");
      return { kind: "unknown" };
    }
    // Falta ZONA_HORARIA_PERIODO: solo lo arregla el dueño de la base.
    if (published.answer === "unavailable") await deps.report("legal_change_unavailable");
    if (published.answer === "changed" && published.version !== null) {
      const twin = await sameAsLast(admitted.claims, { docType, version: published.version, seenVersion, title: title.title, sha: seenSha, day });
      if (twin !== null) return { kind: "answered", answer: "published", id: twin.id, version: twin.version, effectiveFrom: twin.effectiveFrom };
    }
    return { kind: "answered", ...published };
  }

  /**
   * Un doble clic sin JavaScript manda «Publicar» dos veces: el segundo envío encuentra la versión que
   * entró con el primero y la base contesta `changed`. Si esa última versión tiene el mismo título y la
   * misma huella que lo que se confirmó, lo confirmado ya está publicado: decir «otra persona publicó»
   * invitaría a publicarlo otra vez (y, con unos términos, a pedirle a todas las cuentas que acepten de
   * nuevo). Tiene que ser justo lo que este envío habría publicado: la versión siguiente a la vista (nunca
   * un borrador, que es la 0), y vigente desde hoy. Otra persona pudo publicar el mismo texto con otro día, y entonces
   * no rige cuando se pidió. Un día futuro se queda en `changed`: aquí no se sabe la zona del periodo para
   * comparar el día de una programada, y publicarla otra vez con el mismo día no pide aceptar dos veces.
   * Sin lectura, también `changed`, que no publica nada.
   */
  async function sameAsLast(
    claims: VerifiedClaims,
    sent: { docType: LegalDocType; version: number; seenVersion: number | null; title: string; sha: string; day: string },
  ): Promise<LegalVersion | null> {
    if (sent.version !== (sent.seenVersion ?? 0) + 1) return null;
    let documents: LegalDocuments | null;
    try {
      documents = await store.documents(claims);
    } catch {
      return null;
    }
    if (documents === null || sent.day !== documents.today) return null;
    const versions = documents.documents.find((row) => row.docType === sent.docType)?.versions ?? [];
    const last = versions.reduce<LegalVersion | undefined>((top, each) => (top === undefined || each.version > top.version ? each : top), undefined);
    const same = last !== undefined && last.version === sent.version && last.state === "current";
    return same && last.title === sent.title && last.bodySha256 === sent.sha ? last : null;
  }

  /**
   * Dar el código otra vez (PA-89, «Tu código»). Lo reciente se comprueba con la lectura de los textos,
   * que solo pide configuración, como la del equipo.
   */
  async function giveLegalCode(jar: CookieJar, code: string): Promise<LegalCode> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const given = await core.giveSecondFactorCode(jar, code);
    switch (given.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
      case "unavailable":
        return { kind: given.kind };
      default:
        // Dejó de ser del equipo, o su sesión ya no vale: decide la página.
        return { kind: "refused" };
    }
    // Con la sesión como quedó en ese tarro: verificar escribió su cookie.
    const again = await admit(jar);
    if (!again.ok) return again.result;
    let documents: LegalDocuments | null;
    try {
      documents = await store.documents(again.claims);
    } catch {
      await deps.report("legal_change_unavailable");
      return { kind: "not_available" };
    }
    if (documents === null) return { kind: "refused" };
    if (documents.freshCode) return { kind: "verified" };
    await deps.report("legal_change_unavailable");
    return { kind: "not_available" };
  }

  return { legalDocuments, legalVersion, publishLegalVersion, giveLegalCode };
}
