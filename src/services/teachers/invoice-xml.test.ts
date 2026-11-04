import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { readInvoiceXml } from "./invoice-xml";

// El XML de la factura, de los bytes a lo leído (T-604): primero los bytes, después el árbol y después el CFDI. Los casos hostiles
// del plan (bomba de entidades, XML truncado, entidades externas) y una factura de honorarios como la que manda un facturador.

const GOOD = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd"
  Version="4.0" Serie="A" Folio="17" Fecha="2026-11-03T10:00:00" Sello="AAAA" NoCertificado="00001000000500000000" Certificado="BBBB"
  SubTotal="1000.00" Moneda="MXN" Total="953.33" TipoDeComprobante="I" Exportacion="01" MetodoPago="PUE" FormaPago="03" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="GOMA800101AB1" Nombre="ANA GÓMEZ" RegimenFiscal="612"/>
  <cfdi:Receptor Rfc="PHO200101AB1" Nombre="PLATAFORMA" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="86101700" Cantidad="1" ClaveUnidad="E48" Descripcion="Cursos &amp; talleres" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados>
        <cfdi:Retenciones>
          <cfdi:Retencion Base="1000.00" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.100000" Importe="100.00"/>
          <cfdi:Retencion Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.106667" Importe="106.67"/>
        </cfdi:Retenciones>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosRetenidos="206.67" TotalImpuestosTrasladados="160.00">
    <cfdi:Retenciones><cfdi:Retencion Impuesto="001" Importe="100.00"/><cfdi:Retencion Impuesto="002" Importe="106.67"/></cfdi:Retenciones>
    <cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="6F9619FF-8B86-D011-B42D-00C04FC964FF"
      FechaTimbrado="2026-11-03T10:01:00" RfcProvCertif="SAT970701NN3" SelloCFD="AAAA" NoCertificadoSAT="00001000000500000000" SelloSAT="CCCC"/>
  </cfdi:Complemento>
  <cfdi:Addenda><Proveedor xmlns="urn:proveedor" Pedido="99"/></cfdi:Addenda>
</cfdi:Comprobante>`;

const bytes = (text: string) => new TextEncoder().encode(text);
const outcome = (text: string) => {
  const read = readInvoiceXml(bytes(text));
  return read.kind === "ok" ? "ok" : read.problem;
};

describe("una factura de un facturador", () => {
  it("se lee, con su huella", () => {
    const read = readInvoiceXml(bytes(GOOD));
    expect(read).toMatchObject({
      kind: "ok",
      sha256: createHash("sha256").update(GOOD).digest("hex"),
      facts: { uuid: "6f9619ff-8b86-d011-b42d-00c04fc964ff", issuerName: "ANA GÓMEZ", subtotalCents: 100000, vatWithheldCents: 10667, totalCents: 95333 },
    });
  });
});

describe("lo hostil", () => {
  const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
    <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>`;

  it.each([
    ["la bomba de entidades", laughs, "doctype"],
    ["una entidad externa", GOOD.replace("<cfdi:Comprobante", '<!DOCTYPE c [<!ENTITY x SYSTEM "file:///etc/passwd">]><cfdi:Comprobante'), "doctype"],
    ["truncado", GOOD.slice(0, GOOD.length - 40), "not_xml"],
    ["una entidad sin declarar", GOOD.replace("Cursos &amp;", "Cursos &x;"), "not_xml"],
    ["un PDF renombrado", "%PDF-1.7\n%âãÏÓ\n1 0 obj", "not_xml"],
    ["otro espacio de nombres", GOOD.replaceAll("http://www.sat.gob.mx/cfd/4", "http://www.sat.gob.mx/cfd/3"), "not_cfdi"],
    ["un CFDI 3.3", GOOD.replace('Version="4.0"', 'Version="3.3"'), "not_cfdi"],
    ["un tercer decimal", GOOD.replace('SubTotal="1000.00"', 'SubTotal="1000.005"'), "amount"],
    ["un IEPS", GOOD.replace('<cfdi:Retencion Impuesto="001"', '<cfdi:Retencion Impuesto="003"'), "unsupported_tax"],
    ["sin timbre", GOOD.replace(/<cfdi:Complemento>[\s\S]*<\/cfdi:Complemento>/, ""), "no_stamp"],
    ["vacío", "", "empty"],
  ])("%s: %s", (_label, text, expected) => {
    expect(outcome(text)).toBe(expected);
  });

  it("en UTF-16, no", () => {
    const utf16 = Buffer.from(`﻿${GOOD}`, "utf16le");
    expect(readInvoiceXml(new Uint8Array(utf16))).toEqual({ kind: "problem", problem: "encoding" });
  });

  it("en otra codificación declarada, no", () => {
    expect(outcome(GOOD.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'))).toBe("not_xml");
  });
});
