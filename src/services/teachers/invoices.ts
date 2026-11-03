import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { CfdiFacts } from "@/domain/fiscal/cfdi";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";
import type { InvoiceFiles } from "@/services/media/invoice-files";

import { readInvoiceXml, type InvoiceXmlProblem } from "./invoice-xml";
import type { SealedField, TaxFieldContext } from "./tax-cipher";
import type { TaxReadAnswer } from "./tax-profile";

// La factura del maestro (RF-512, FL-40; T-604, tercera solicitud): sin pantalla todavía (PA-47 y PA-82 llegan con la quinta). El maestro empieza (la base
// reserva la fila y la ruta), sube el PDF del navegador a la cubeta con la dirección firmada, y manda el XML. Aquí se lee el XML, se compara el RFC del
// emisor con el de sus datos (que solo se abre aquí), se mira que el PDF empiece como PDF y se cifra el XML; lo demás lo compara la base, y lo que no
// coincide lo rechaza al subir (decisión 1 de Sergio del 2026-11-02). Finanzas acepta o rechaza con motivo.

export type InvoiceBeginAnswer =
  | { outcome: "begun"; invoice: string; path: string; expiresAt: string }
  | { outcome: "not_teacher" | "not_found" | "changed" | "not_awaiting" | "receiver_missing" | "already_in_progress" | "throttled" };

/** Lo que se le manda a la base al subir. */
export interface InvoiceSeal {
  invoice: string;
  xml: SealedField;
  /** De los bytes como llegaron, en hexadecimal. */
  sha256: string;
  facts: CfdiFacts;
  issuerMatches: boolean;
  profileVersion: number;
  /** Nulo si no se pudo leer el principio del PDF: la base contesta «no se supo» y la subida se queda. */
  pdfOk: boolean | null;
}

export type InvoiceAmountField = "subtotal_cents" | "vat_cents" | "income_tax_withheld_cents" | "vat_withheld_cents" | "total_cents";

export type InvoiceSubmitAnswer =
  | { outcome: "submitted" }
  | { outcome: "amounts_mismatch"; fields: InvoiceAmountField[] }
  | {
      outcome:
        | "not_teacher" | "not_found" | "already_submitted" | "expired" | "changed" | "not_uploaded" | "unavailable" | "pdf_invalid" | "malformed"
        | "profile_changed" | "receiver_missing" | "issuer_mismatch" | "regime_mismatch" | "receiver_mismatch" | "duplicate_cfdi";
    };

export type InvoiceReviewAnswer =
  | "accepted" | "rejected" | "forbidden" | "needs_fresh_code" | "malformed" | "not_found" | "self" | "not_in_review" | "on_hold" | "changed" | "receiver_changed";

export type InvoiceFileAnswer =
  | { outcome: "pdf"; path: string; version: string }
  | { outcome: "xml"; teacher: string; xml: Buffer }
  | { outcome: "malformed" | "not_found" | "self" | "file_changed" | "forbidden" | "needs_fresh_code" };

export interface InvoiceStore {
  begin: (claims: VerifiedClaims, payout: string, seen: string) => Promise<InvoiceBeginAnswer>;
  /** A dónde subió y en qué va su factura, o nulo si no es suya. */
  upload: (claims: VerifiedClaims, invoice: string) => Promise<{ path: string; payout: string; status: string } | null>;
  submit: (claims: VerifiedClaims, seal: InvoiceSeal) => Promise<InvoiceSubmitAnswer>;
  cancel: (claims: VerifiedClaims, invoice: string) => Promise<"cancelled" | "not_teacher" | "not_found" | "not_uploading">;
  review: (claims: VerifiedClaims, invoice: string, decision: { accept: true } | { accept: false; reason: string }) => Promise<InvoiceReviewAnswer>;
  file: (claims: VerifiedClaims, invoice: string, kind: "pdf" | "xml") => Promise<InvoiceFileAnswer>;
  unused: (claims: VerifiedClaims, payout: string) => Promise<string[]>;
}

export interface InvoicesDeps {
  store: InvoiceStore;
  files: InvoiceFiles;
  /** Los datos fiscales del maestro, con lo cifrado sin abrir: deja su lectura en la auditoría. */
  mine: (claims: VerifiedClaims) => Promise<TaxReadAnswer>;
  cipher: {
    available: () => boolean;
    seal: (context: TaxFieldContext, text: string) => SealedField;
    open: (context: TaxFieldContext, sealed: Buffer) => string;
  };
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
}

type Refused = Exclude<SessionCheck, { kind: "pass" }>;
type Session = { kind: "session"; check: Refused };

export type InvoiceBegin = { kind: "begun"; invoice: string; uploadUrl: string; expiresAt: string } | { kind: Exclude<InvoiceBeginAnswer["outcome"], "begun"> | "unavailable" } | Session;
export type InvoiceSubmit =
  | { kind: "submitted" }
  | { kind: "amounts_mismatch"; fields: InvoiceAmountField[] }
  | { kind: "xml"; problem: InvoiceXmlProblem }
  | { kind: Exclude<InvoiceSubmitAnswer["outcome"], "submitted" | "amounts_mismatch"> | "no_profile" | "off" }
  | Session;
export type InvoiceCancel = { kind: "cancelled" | "not_teacher" | "not_found" | "not_uploading" | "unavailable" } | Session;
export type InvoiceReview = { kind: InvoiceReviewAnswer | "unavailable" } | Session;
export type InvoiceFile =
  | { kind: "url"; url: string }
  | { kind: "xml"; text: string }
  | { kind: "malformed" | "not_found" | "self" | "file_changed" | "forbidden" | "needs_fresh_code" | "off" | "unavailable" }
  | Session;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = /^[a-z_]{1,32}$/;

/** Las respuestas que borran la fila: el PDF de esa subida ya no lo nombra nadie. */
const DROPS_ROW: ReadonlySet<string> = new Set([
  "expired", "changed", "pdf_invalid", "malformed", "issuer_mismatch", "regime_mismatch", "receiver_mismatch", "amounts_mismatch", "duplicate_cfdi",
]);

/** Un RFC como se compara: sin espacios ni guiones, en mayúsculas, con la Ñ compuesta. */
const comparable = (rfc: string) => rfc.normalize("NFC").replace(/[\s-]/g, "").toUpperCase();

export function createInvoices(deps: InvoicesDeps) {
  const { store, files, cipher, report } = deps;

  async function session(reader: CookieReader): Promise<VerifiedClaims | Session> {
    const check = await deps.checkSession(reader);
    return check.kind === "pass" ? check.claims : { kind: "session", check };
  }
  const refused = (value: VerifiedClaims | Session): value is Session => "kind" in value && value.kind === "session";

  async function cipherIsOff(): Promise<boolean> {
    if (cipher.available()) return false;
    await report("tax_cipher_unavailable");
    return true;
  }

  /** Lo que sobra en la carpeta de esa liquidación. Una falla no tumba lo que ya pasó: se reporta, y lo alcanza el barrido. */
  async function cleanUp(claims: VerifiedClaims, payout: string): Promise<void> {
    try {
      await files.remove(await store.unused(claims, payout));
    } catch {
      await report("invoice_cleanup_failed");
    }
  }

  /** Empezar: la base reserva, y aquí se firma la subida del PDF. Si no se pudo firmar se cancela lo reservado, que ocuparía la subida 3 h. */
  async function beginInvoice(reader: CookieReader, payout: string, seen: string): Promise<InvoiceBegin> {
    if (!ID.test(payout) || !STATUS.test(seen)) return { kind: "not_found" };
    const claims = await session(reader);
    if (refused(claims)) return claims;
    try {
      const answer = await store.begin(claims, payout, seen);
      if (answer.outcome !== "begun") return { kind: answer.outcome };
      const uploadUrl = await files.signUpload(answer.path);
      if (uploadUrl === null) {
        await store.cancel(claims, answer.invoice);
        await report("invoice_unavailable");
        return { kind: "unavailable" };
      }
      // Lo que sobró en su carpeta (una subida que venció, o un rechazo cuyo borrado falló) se va ahora: la nueva ya nombra su ruta.
      await cleanUp(claims, payout);
      return { kind: "begun", invoice: answer.invoice, uploadUrl, expiresAt: answer.expiresAt };
    } catch {
      await report("invoice_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Subir: el PDF ya está en la cubeta, y aquí llega el XML. Un XML que no se lee no llega a la base, y la subida se queda para otro intento. El RFC del emisor se
   * compara con el de sus datos, abiertos aquí (esa lectura queda en la auditoría); lo demás lo compara la base.
   */
  async function submitInvoice(reader: CookieReader, invoice: string, xml: Uint8Array): Promise<InvoiceSubmit> {
    if (!ID.test(invoice)) return { kind: "not_found" };
    const claims = await session(reader);
    if (refused(claims)) return claims;
    if (await cipherIsOff()) return { kind: "off" };
    const reading = readInvoiceXml(xml);
    if (reading.kind === "problem") return { kind: "xml", problem: reading.problem };
    let answer: InvoiceSubmitAnswer;
    let payout: string;
    try {
      // Primero si es suya y se está subiendo: abrir sus datos deja una lectura en la auditoría, y no se gasta en una factura ajena o ya subida.
      const upload = await store.upload(claims, invoice);
      if (upload === null) return { kind: "not_found" };
      if (upload.status !== "uploading") return { kind: "already_submitted" };
      payout = upload.payout;
      const mine = await deps.mine(claims);
      if (mine.outcome !== "ok") return { kind: mine.outcome === "no_profile" ? "no_profile" : "not_teacher" };
      let rfc: string;
      try {
        rfc = cipher.open({ teacher: mine.row.teacherId, rowVersion: mine.row.version, field: "rfc" }, mine.row.rfc);
      } catch {
        await report("tax_profile_unreadable");
        return { kind: "unavailable" };
      }
      // Con su marca de UTF-8, si la trae: lo cifrado vuelve a ser el archivo exacto, y su huella se puede comprobar.
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(xml);
      answer = await store.submit(claims, {
        invoice,
        xml: cipher.seal({ teacher: mine.row.teacherId, field: "invoice_xml", invoice }, text),
        sha256: reading.sha256,
        facts: reading.facts,
        issuerMatches: comparable(reading.facts.issuerRfc) === comparable(rfc),
        profileVersion: mine.row.version,
        pdfOk: await files.pdfOk(upload.path),
      });
    } catch {
      await report("invoice_unavailable");
      return { kind: "unavailable" };
    }
    if (DROPS_ROW.has(answer.outcome)) await cleanUp(claims, payout);
    if (answer.outcome === "unavailable") await report("invoice_unavailable");
    if (answer.outcome === "amounts_mismatch") return { kind: "amounts_mismatch", fields: answer.fields };
    return { kind: answer.outcome };
  }

  async function cancelInvoice(reader: CookieReader, invoice: string): Promise<InvoiceCancel> {
    if (!ID.test(invoice)) return { kind: "not_found" };
    const claims = await session(reader);
    if (refused(claims)) return claims;
    try {
      const upload = await store.upload(claims, invoice);
      const answer = await store.cancel(claims, invoice);
      if (answer === "cancelled" && upload !== null) await cleanUp(claims, upload.payout);
      return { kind: answer };
    } catch {
      await report("invoice_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** Aceptar o rechazar, como finanzas: la puerta, sobre sí y lo retenido los decide la base. */
  async function reviewInvoice(reader: CookieReader, invoice: string, decision: { accept: true } | { accept: false; reason: string }): Promise<InvoiceReview> {
    if (!ID.test(invoice)) return { kind: "not_found" };
    const claims = await session(reader);
    if (refused(claims)) return claims;
    try {
      return { kind: await store.review(claims, invoice, decision) };
    } catch {
      await report("invoice_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** Bajar: el PDF por una dirección firmada de 5 minutos, como adjunto; el XML, abierto aquí. Quién puede, y la lectura de finanzas, los decide la base. */
  async function invoiceFile(reader: CookieReader, invoice: string, kind: "pdf" | "xml"): Promise<InvoiceFile> {
    if (!ID.test(invoice)) return { kind: "not_found" };
    const claims = await session(reader);
    if (refused(claims)) return claims;
    if (kind === "xml" && (await cipherIsOff())) return { kind: "off" };
    let answer: InvoiceFileAnswer;
    try {
      answer = await store.file(claims, invoice, kind);
    } catch {
      await report("invoice_unavailable");
      return { kind: "unavailable" };
    }
    if (answer.outcome === "pdf") {
      const url = await files.signDownload(answer.path, `factura-${invoice.slice(0, 8)}.pdf`);
      if (url === null) {
        await report("invoice_unavailable");
        return { kind: "unavailable" };
      }
      return { kind: "url", url };
    }
    if (answer.outcome === "xml") {
      try {
        return { kind: "xml", text: cipher.open({ teacher: answer.teacher, field: "invoice_xml", invoice }, answer.xml) };
      } catch {
        await report("invoice_unreadable");
        return { kind: "unavailable" };
      }
    }
    return { kind: answer.outcome };
  }

  return { beginInvoice, submitInvoice, cancelInvoice, reviewInvoice, invoiceFile };
}
