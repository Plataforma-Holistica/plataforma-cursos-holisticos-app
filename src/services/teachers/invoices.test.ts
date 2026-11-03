import { describe, expect, it } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";
import type { InvoiceFiles } from "@/services/media/invoice-files";

import { createInvoices, type InvoiceSeal, type InvoiceStore } from "./invoices";
import type { SealedField, TaxFieldContext } from "./tax-cipher";
import type { TaxReadAnswer } from "./tax-profile";

// El servicio de la factura del maestro (T-604), con la base, la cubeta y el cifrado simulados: qué se le pregunta a quién y en qué orden. Lo que la base
// decide lo prueba la 80, y el camino contra la base y el Storage locales, la integración 88.

const TEACHER = "a0000000-0000-4000-8000-000000000001";
const INVOICE = "c0000000-0000-4000-8000-000000000001";
const PAYOUT = "b0000000-0000-4000-8000-000000000001";
const PATH = `${TEACHER}/${PAYOUT}/${INVOICE}.pdf`;
const claims = { sub: TEACHER } as unknown as VerifiedClaims;
const reader = {} as CookieReader;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-11-03T10:00:00" SubTotal="1000.00" Moneda="MXN" Total="953.33" TipoDeComprobante="I">
  <cfdi:Emisor Rfc="goma800101ab1" Nombre="ANA GÓMEZ" RegimenFiscal="612"/>
  <cfdi:Receptor Rfc="PHO200101AB1"/>
  <cfdi:Impuestos TotalImpuestosRetenidos="206.67" TotalImpuestosTrasladados="160.00">
    <cfdi:Retenciones><cfdi:Retencion Impuesto="001" Importe="100.00"/><cfdi:Retencion Impuesto="002" Importe="106.67"/></cfdi:Retenciones>
    <cfdi:Traslados><cfdi:Traslado Impuesto="002" TipoFactor="Tasa" Importe="160.00"/></cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="6F9619FF-8B86-D011-B42D-00C04FC964FF" FechaTimbrado="2026-11-03T10:01:00"/></cfdi:Complemento>
</cfdi:Comprobante>`;
const bytes = (text: string) => new TextEncoder().encode(text);

function harness(change: { store?: Partial<InvoiceStore>; files?: Partial<InvoiceFiles>; mine?: TaxReadAnswer; session?: SessionCheck; cipherOn?: boolean } = {}) {
  const calls: string[] = [];
  const reported: FailureCode[] = [];
  const sealed: { context: TaxFieldContext; text: string }[] = [];
  let submitted: InvoiceSeal | null = null;
  const store: InvoiceStore = {
    begin: async () => ({ outcome: "begun", invoice: INVOICE, path: PATH, expiresAt: "2026-11-03T13:00:00.000Z" }),
    upload: async () => ({ path: PATH, payout: PAYOUT }),
    submit: async (_claims, seal) => {
      submitted = seal;
      calls.push("submit");
      return { outcome: "submitted" };
    },
    cancel: async () => {
      calls.push("cancel");
      return "cancelled";
    },
    review: async () => "accepted",
    file: async () => ({ outcome: "pdf", path: PATH, version: "v1" }),
    unused: async () => {
      calls.push("unused");
      return [PATH];
    },
    ...change.store,
  };
  const files: InvoiceFiles = {
    signUpload: async () => "http://storage/subir",
    signDownload: async () => "http://storage/bajar",
    pdfOk: async () => true,
    remove: async (paths) => {
      calls.push(`remove:${paths.join(",")}`);
    },
    ...change.files,
  };
  const service = createInvoices({
    store,
    files,
    mine: async () => {
      calls.push("mine");
      return (
        change.mine ?? {
          outcome: "ok",
          row: { teacherId: TEACHER, version: 2, regime: "612", payee: "person", last4: "7771", updatedAt: "", rfc: Buffer.from("rfc"), legalName: Buffer.from("n"), clabe: Buffer.from("c") },
        }
      );
    },
    cipher: {
      available: () => change.cipherOn ?? true,
      seal: (context, text) => {
        sealed.push({ context, text });
        return Buffer.from(`sellado:${text.length}`) as SealedField;
      },
      open: (context) => (context.field === "rfc" ? "GOMA 800101 AB1" : "<xml/>"),
    },
    checkSession: async () => change.session ?? { kind: "pass", claims },
    report: async (code) => {
      reported.push(code);
    },
  });
  return { service, calls, reported, sealed, submitted: () => submitted };
}

describe("empezar", () => {
  it("la base reserva y aquí se firma la subida", async () => {
    const { service } = harness();
    expect(await service.beginInvoice(reader, PAYOUT, "awaiting_invoice")).toEqual({
      kind: "begun", invoice: INVOICE, uploadUrl: "http://storage/subir", expiresAt: "2026-11-03T13:00:00.000Z",
    });
  });

  it("si no se pudo firmar, se cancela lo reservado: ocuparía la subida 3 h", async () => {
    const { service, calls } = harness({ files: { signUpload: async () => null } });
    expect(await service.beginInvoice(reader, PAYOUT, "awaiting_invoice")).toEqual({ kind: "unavailable" });
    expect(calls).toContain("cancel");
  });

  it("lo que no es un identificador no llega a la base", async () => {
    const { service, calls } = harness();
    expect(await service.beginInvoice(reader, "x", "awaiting_invoice")).toEqual({ kind: "not_found" });
    expect(calls).toEqual([]);
  });
});

describe("subir", () => {
  it("lee, compara el RFC sin espacios ni mayúsculas, cifra el XML con su factura y lo manda", async () => {
    const { service, sealed, submitted } = harness();
    expect(await service.submitInvoice(reader, INVOICE, bytes(XML))).toEqual({ kind: "submitted" });
    expect(sealed).toEqual([{ context: { teacher: TEACHER, field: "invoice_xml", invoice: INVOICE }, text: XML }]);
    expect(submitted()).toMatchObject({ invoice: INVOICE, issuerMatches: true, profileVersion: 2, pdfOk: true, facts: { uuid: "6f9619ff-8b86-d011-b42d-00c04fc964ff", totalCents: 95333 } });
  });

  it("un XML que no se lee no llega a la base, y la subida se queda para otro intento", async () => {
    const { service, calls } = harness();
    expect(await service.submitInvoice(reader, INVOICE, bytes("<!DOCTYPE x><x/>"))).toEqual({ kind: "xml", problem: "doctype" });
    expect(calls).toEqual([]);
  });

  it("otro RFC se manda como tal: la base la rechaza", async () => {
    const { service, submitted } = harness();
    await service.submitInvoice(reader, INVOICE, bytes(XML.replace("goma800101ab1", "XAXX010101000")));
    expect(submitted()?.issuerMatches).toBe(false);
  });

  it("un rechazo al subir se lleva el PDF que ya nadie nombra", async () => {
    const { service, calls } = harness({ store: { submit: async () => ({ outcome: "amounts_mismatch", fields: ["vat_cents"] }) } });
    expect(await service.submitInvoice(reader, INVOICE, bytes(XML))).toEqual({ kind: "amounts_mismatch", fields: ["vat_cents"] });
    expect(calls).toEqual(["mine", "unused", `remove:${PATH}`]);
  });

  it("si no se pudo borrar, se reporta y la respuesta es la misma", async () => {
    const { service, reported } = harness({
      store: { submit: async () => ({ outcome: "issuer_mismatch" }) },
      files: { remove: async () => { throw new Error("storage"); } },
    });
    expect(await service.submitInvoice(reader, INVOICE, bytes(XML))).toEqual({ kind: "issuer_mismatch" });
    expect(reported).toEqual(["invoice_cleanup_failed"]);
  });

  it("sin llave no se sube nada, y se reporta", async () => {
    const { service, calls, reported } = harness({ cipherOn: false });
    expect(await service.submitInvoice(reader, INVOICE, bytes(XML))).toEqual({ kind: "off" });
    expect(calls).toEqual([]);
    expect(reported).toEqual(["tax_cipher_unavailable"]);
  });

  it("sin sus datos fiscales no hay con qué comparar", async () => {
    const { service, calls } = harness({ mine: { outcome: "no_profile" } });
    expect(await service.submitInvoice(reader, INVOICE, bytes(XML))).toEqual({ kind: "no_profile" });
    expect(calls).toEqual(["mine"]);
  });

  it("si la base falla, «no se supo», y se reporta", async () => {
    const { service, reported } = harness({ store: { submit: async () => { throw new Error("base"); } } });
    expect(await service.submitInvoice(reader, INVOICE, bytes(XML))).toEqual({ kind: "unavailable" });
    expect(reported).toEqual(["invoice_unavailable"]);
  });
});

describe("bajar", () => {
  it("el PDF baja por una dirección firmada; el XML se abre con su factura", async () => {
    const pdf = harness();
    expect(await pdf.service.invoiceFile(reader, INVOICE, "pdf")).toEqual({ kind: "url", url: "http://storage/bajar" });
    const xml = harness({ store: { file: async () => ({ outcome: "xml", teacher: TEACHER, xml: Buffer.from("x") }) } });
    expect(await xml.service.invoiceFile(reader, INVOICE, "xml")).toEqual({ kind: "xml", text: "<xml/>" });
  });
});
