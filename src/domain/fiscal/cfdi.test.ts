import { describe, expect, it } from "vitest";

import { CFDI_MAX_BYTES, cfdiBytesProblem, readCfdi, type XmlNode } from "./cfdi";

// La lectura de la factura del maestro (RF-512, FL-40; T-604). El árbol lo arma el adaptador de XML; aquí se arma a mano. Lo que se
// lee es lo que la base compara con la liquidación: si no coincide, la factura se rechaza al subir (decisión 1 de Sergio del 2026-11-02).
// Las reglas del CFDI 4.0 son las del Anexo 20 del SAT; lo que no se dice aquí no se revisa (el sello, los conceptos).

const CFD = "http://www.sat.gob.mx/cfd/4";
const TFD = "http://www.sat.gob.mx/TimbreFiscalDigital";

const el = (name: string, attrs: Record<string, string> = {}, children: readonly XmlNode[] = [], ns = CFD): XmlNode => ({ ns, name, attrs, children });

const STAMP = el("TimbreFiscalDigital", { Version: "1.1", UUID: "6F9619FF-8B86-D011-B42D-00C04FC964FF", FechaTimbrado: "2026-11-03T10:01:00" }, [], TFD);

const TAXES = el("Impuestos", { TotalImpuestosRetenidos: "206.67", TotalImpuestosTrasladados: "160.00" }, [
  el("Retenciones", {}, [el("Retencion", { Impuesto: "001", Importe: "100.00" }), el("Retencion", { Impuesto: "002", Importe: "106.67" })]),
  el("Traslados", {}, [el("Traslado", { Base: "1000.00", Impuesto: "002", TipoFactor: "Tasa", TasaOCuota: "0.160000", Importe: "160.00" })]),
]);

// Un concepto con sus propios impuestos, con los mismos nombres que los del comprobante: no se cuentan.
const CONCEPTS = el("Conceptos", {}, [
  el("Concepto", { Importe: "1000.00", ObjetoImp: "02" }, [
    el("Impuestos", {}, [
      el("Traslados", {}, [el("Traslado", { Base: "1000.00", Impuesto: "002", TipoFactor: "Tasa", TasaOCuota: "0.160000", Importe: "160.00" })]),
      el("Retenciones", {}, [el("Retencion", { Base: "1000.00", Impuesto: "001", TipoFactor: "Tasa", TasaOCuota: "0.100000", Importe: "100.00" })]),
    ]),
  ]),
]);

const ROOT_ATTRS = {
  Version: "4.0", Serie: "A", Folio: "17", Fecha: "2026-11-03T10:00:00", SubTotal: "1000.00", Moneda: "MXN", Total: "953.33",
  TipoDeComprobante: "I", MetodoPago: "PUE", Exportacion: "01", LugarExpedicion: "06600",
};

function invoice(change: { attrs?: Record<string, string | undefined>; children?: readonly XmlNode[]; taxes?: XmlNode | null } = {}): XmlNode {
  const attrs = Object.fromEntries(Object.entries({ ...ROOT_ATTRS, ...change.attrs }).filter((e): e is [string, string] => e[1] !== undefined));
  const children = change.children ?? [
    el("Emisor", { Rfc: "GOMA800101AB1", Nombre: "ANA GOMEZ", RegimenFiscal: "612" }),
    el("Receptor", { Rfc: "PHO200101AB1", Nombre: "PLATAFORMA", RegimenFiscalReceptor: "601", UsoCFDI: "G03", DomicilioFiscalReceptor: "06600" }),
    CONCEPTS,
    ...(change.taxes === null ? [] : [change.taxes ?? TAXES]),
    el("Complemento", {}, [STAMP]),
  ];
  return el("Comprobante", attrs, children);
}

const problem = (root: XmlNode) => {
  const reading = readCfdi(root);
  return reading.kind === "problem" ? reading.problem : "ok";
};

const facts = (root: XmlNode) => {
  const reading = readCfdi(root);
  if (reading.kind !== "ok") throw new Error(`esperaba una lectura: ${reading.problem}`);
  return reading.facts;
};

describe("una factura de honorarios", () => {
  it("se lee completa", () => {
    expect(facts(invoice())).toEqual({
      uuid: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
      series: "A",
      folio: "17",
      issuedAt: "2026-11-03T10:00:00",
      stampedAt: "2026-11-03T10:01:00",
      issuerRfc: "GOMA800101AB1",
      issuerName: "ANA GOMEZ",
      issuerRegime: "612",
      receiverRfc: "PHO200101AB1",
      receiverRegime: "601",
      use: "G03",
      paymentMethod: "PUE",
      subtotalCents: 100000,
      vatCents: 16000,
      incomeTaxWithheldCents: 10000,
      vatWithheldCents: 10667,
      totalCents: 95333,
    });
  });

  it("sin serie, folio, método ni uso, los da nulos: no rechazan (decisión 3 de Sergio del 2026-11-03)", () => {
    const root = invoice({ attrs: { Serie: undefined, Folio: undefined, MetodoPago: undefined } });
    const receptor = el("Receptor", { Rfc: "PHO200101AB1" });
    const read = facts({ ...root, children: root.children.map((c) => (c.name === "Receptor" ? receptor : c)) });
    expect([read.series, read.folio, read.paymentMethod, read.use, read.receiverRegime]).toEqual([null, null, null, null, null]);
  });
});

describe("los montos", () => {
  it.each([
    ["1000", 100000],
    ["1000.5", 100050],
    ["1000.000000", 100000],
    ["0.01", 1],
  ])("%s son %i centavos", (text, cents) => {
    expect(facts(invoice({ attrs: { SubTotal: text } })).subtotalCents).toBe(cents);
  });

  it.each(["1000.005", "1,000.00", "-1000.00", "1e3", " 1000.00", "01000.00", "", "10000000000000.00", "1000."])("%j no es un monto", (text) => {
    expect(problem(invoice({ attrs: { SubTotal: text } }))).toBe("amount");
  });

  it("sin impuestos, todo en cero: es válido sin ningún concepto objeto de impuesto", () => {
    const read = facts(invoice({ taxes: null }));
    expect([read.vatCents, read.incomeTaxWithheldCents, read.vatWithheldCents]).toEqual([0, 0, 0]);
  });

  it("un traslado exento cuenta como cero, sin importe", () => {
    const exempt = el("Impuestos", {}, [el("Traslados", {}, [el("Traslado", { Base: "1000.00", Impuesto: "002", TipoFactor: "Exento" })])]);
    expect(facts(invoice({ taxes: exempt })).vatCents).toBe(0);
  });

  it("un exento con importe no tiene forma", () => {
    const exempt = el("Impuestos", {}, [el("Traslados", {}, [el("Traslado", { Impuesto: "002", TipoFactor: "Exento", Importe: "1.00" })])]);
    expect(problem(invoice({ taxes: exempt }))).toBe("shape");
  });

  it("varios traslados de IVA se suman", () => {
    const two = el("Impuestos", { TotalImpuestosTrasladados: "160.00" }, [
      el("Traslados", {}, [
        el("Traslado", { Impuesto: "002", TipoFactor: "Tasa", Importe: "100.00" }),
        el("Traslado", { Impuesto: "002", TipoFactor: "Tasa", Importe: "60.00" }),
      ]),
    ]);
    expect(facts(invoice({ taxes: two })).vatCents).toBe(16000);
  });

  it.each([
    ["IEPS trasladado", el("Traslados", {}, [el("Traslado", { Impuesto: "003", TipoFactor: "Tasa", Importe: "1.00" })])],
    ["una cuota", el("Traslados", {}, [el("Traslado", { Impuesto: "002", TipoFactor: "Cuota", Importe: "1.00" })])],
    ["IEPS retenido", el("Retenciones", {}, [el("Retencion", { Impuesto: "003", Importe: "1.00" })])],
    ["un impuesto desconocido", el("Retenciones", {}, [el("Retencion", { Impuesto: "009", Importe: "1.00" })])],
  ])("%s no se acepta", (_label, group) => {
    expect(problem(invoice({ taxes: el("Impuestos", {}, [group]) }))).toBe("unsupported_tax");
  });

  it("los totales del comprobante tienen que ser la suma de sus impuestos", () => {
    const wrong = el("Impuestos", { TotalImpuestosRetenidos: "200.00", TotalImpuestosTrasladados: "160.00" }, TAXES.children);
    expect(problem(invoice({ taxes: wrong }))).toBe("shape");
  });

  it("un total que no cuadra se lee igual: lo rechaza la base al compararlo con la liquidación (un complemento de impuestos locales)", () => {
    expect(facts(invoice({ attrs: { Total: "900.00" } })).totalCents).toBe(90000);
  });

  it("un descuento no se acepta, pero uno en cero sí", () => {
    expect(problem(invoice({ attrs: { Descuento: "10.00" } }))).toBe("discount");
    expect(problem(invoice({ attrs: { Descuento: "0.00" } }))).toBe("ok");
  });
});

describe("la forma del comprobante", () => {
  it.each([
    ["otra versión", { Version: "3.3" }, "not_cfdi"],
    ["un egreso", { TipoDeComprobante: "E" }, "not_income"],
    ["un complemento de pago", { TipoDeComprobante: "P" }, "not_income"],
    ["en dólares", { Moneda: "USD" }, "not_mxn"],
    ["sin fecha", { Fecha: undefined }, "shape"],
    ["una fecha sin forma", { Fecha: "03/11/2026" }, "shape"],
    ["un 31 de febrero", { Fecha: "2026-02-31T10:00:00" }, "shape"],
    ["un 29 de febrero que no existe", { Fecha: "2027-02-29T10:00:00" }, "shape"],
    ["sin total", { Total: undefined }, "amount"],
  ])("%s: %s", (_label, attrs, expected) => {
    expect(problem(invoice({ attrs }))).toBe(expected);
  });

  it("otro espacio de nombres no es un CFDI 4.0", () => {
    expect(problem({ ...invoice(), ns: "http://www.sat.gob.mx/cfd/3" })).toBe("not_cfdi");
    expect(problem({ ...invoice(), name: "Retenciones" })).toBe("not_cfdi");
  });

  it.each([
    ["sin emisor", (c: readonly XmlNode[]) => c.filter((n) => n.name !== "Emisor")],
    ["dos emisores", (c: readonly XmlNode[]) => [el("Emisor", { Rfc: "XAXX010101000", Nombre: "X", RegimenFiscal: "612" }), ...c]],
    ["dos receptores", (c: readonly XmlNode[]) => [el("Receptor", { Rfc: "XAXX010101000" }), ...c]],
    ["dos bloques de impuestos", (c: readonly XmlNode[]) => [TAXES, ...c]],
    ["un emisor sin régimen", (c: readonly XmlNode[]) => c.map((n) => (n.name === "Emisor" ? el("Emisor", { Rfc: "GOMA800101AB1", Nombre: "ANA" }) : n))],
    ["un comprobante dentro de otro", (c: readonly XmlNode[]) => [...c, el("Addenda", {}, [invoice()])]],
  ])("%s no tiene forma", (_label, change) => {
    expect(problem(invoice({ children: change(invoice().children) }))).toBe("shape");
  });

  it.each([
    ["sin timbre", (c: readonly XmlNode[]) => c.filter((n) => n.name !== "Complemento")],
    ["un timbre fuera del complemento", (c: readonly XmlNode[]) => [...c.filter((n) => n.name !== "Complemento"), el("Addenda", {}, [STAMP])]],
    ["dos timbres", (c: readonly XmlNode[]) => [...c, el("Addenda", {}, [STAMP])]],
    ["un timbre del 31 de febrero", (c: readonly XmlNode[]) => c.map((n) => (n.name === "Complemento" ? el("Complemento", {}, [{ ...STAMP, attrs: { ...STAMP.attrs, FechaTimbrado: "2026-02-31T10:01:00" } }]) : n))],
    ["un timbre sin folio fiscal", (c: readonly XmlNode[]) => c.map((n) => (n.name === "Complemento" ? el("Complemento", {}, [{ ...STAMP, attrs: { ...STAMP.attrs, UUID: "no" } }]) : n))],
    ["un timbre de otro espacio", (c: readonly XmlNode[]) => c.map((n) => (n.name === "Complemento" ? el("Complemento", {}, [{ ...STAMP, ns: CFD }]) : n))],
  ])("%s: no está timbrada", (_label, change) => {
    expect(problem(invoice({ children: change(invoice().children) }))).toBe("no_stamp");
  });
});

describe("los bytes, antes de leer", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("un XML corriente pasa", () => {
    expect(cfdiBytesProblem(bytes('<?xml version="1.0" encoding="UTF-8"?><cfdi:Comprobante/>'))).toBeNull();
  });

  it("con la marca de UTF-8 también", () => {
    expect(cfdiBytesProblem(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("<a/>")]))).toBeNull();
  });

  it.each([
    ["<!DOCTYPE a [<!ENTITY x 'y'>]><a/>", "doctype"],
    ["<!doctype a><a/>", "doctype"],
    ["<a><!ENTITY x 'y'></a>", "doctype"],
    ["", "empty"],
  ])("%j: %s", (text, expected) => {
    expect(cfdiBytesProblem(bytes(text))).toBe(expected);
  });

  it("UTF-16, con marca o sin ella, no", () => {
    expect(cfdiBytesProblem(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toBe("encoding");
    expect(cfdiBytesProblem(new Uint8Array([0xfe, 0xff, 0x00, 0x3c]))).toBe("encoding");
    expect(cfdiBytesProblem(new Uint8Array([0x3c, 0x00, 0x61, 0x00]))).toBe("encoding");
  });

  it("más del tope, no", () => {
    expect(cfdiBytesProblem(new Uint8Array(CFDI_MAX_BYTES + 1).fill(0x20))).toBe("too_large");
    expect(cfdiBytesProblem(new Uint8Array(CFDI_MAX_BYTES).fill(0x20))).toBeNull();
  });
});
