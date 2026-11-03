// La factura del maestro, leída (RF-512, FL-40; T-604). El XML lo convierte en árbol el adaptador (`src/adapters/xml/`), con sus
// topes; aquí se lee el CFDI 4.0 del Anexo 20 del SAT, y nada más. Lo leído lo compara la base con la liquidación, exacto: si no
// coincide, la factura se rechaza al subir (decisión 1 de Sergio del 2026-11-02).
//
// Leer no es validar: el sello no se revisa, así que un XML editado que coincide pasa. Lo que se lee sirve para que un error de
// captura no llegue a pagarse, no para probar que la factura existe (eso lo dice la consulta del SAT, OP-01).
//
// Los impuestos que cuentan son los hijos del `Impuestos` del comprobante, nunca los de cada concepto, que llevan los mismos nombres.
// Un total que no cuadra con sus partes se lee igual: no coincide con la liquidación, y así se dice (un complemento de impuestos
// locales lo hace, y no es un XML sin forma).

export const CFDI_MAX_BYTES = 256 * 1024;

/** Un elemento del XML, sin texto: el CFDI dice todo en atributos. Solo los atributos sin prefijo. */
export interface XmlNode {
  readonly ns: string;
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export interface CfdiFacts {
  /** En minúsculas: la base lo guarda como `uuid`, y el mismo folio no se esquiva cambiando mayúsculas. */
  uuid: string;
  series: string | null;
  folio: string | null;
  /** Como lo trae el CFDI: `AAAA-MM-DDThh:mm:ss`, en la hora de donde se expidió. */
  issuedAt: string;
  stampedAt: string;
  issuerRfc: string;
  issuerName: string;
  issuerRegime: string;
  receiverRfc: string;
  /** Los tres que deciden si la Plataforma la deduce: no rechazan, y finanzas los ve (decisión 3 de Sergio del 2026-11-03). */
  receiverRegime: string | null;
  use: string | null;
  paymentMethod: string | null;
  subtotalCents: number;
  vatCents: number;
  incomeTaxWithheldCents: number;
  vatWithheldCents: number;
  totalCents: number;
}

export type CfdiProblem = "not_cfdi" | "not_income" | "not_mxn" | "discount" | "amount" | "shape" | "unsupported_tax" | "no_stamp";
export type CfdiBytesProblem = "empty" | "too_large" | "encoding" | "doctype";

export type CfdiReading = { kind: "ok"; facts: CfdiFacts } | { kind: "problem"; problem: CfdiProblem };

const CFD = "http://www.sat.gob.mx/cfd/4";
const TFD = "http://www.sat.gob.mx/TimbreFiscalDigital";
const DATETIME = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Hasta billones de pesos: en centavos cabe sin perder un dígito. Los ceros de más en los decimales se aceptan; un tercer decimal, no.
const AMOUNT = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,6}))?$/;

/** Con forma y un día que existe: la forma sola deja pasar un 31 de febrero, y la base no lo podría leer. */
function isDateTime(text: string | undefined): text is string {
  if (text === undefined || !DATETIME.test(text)) return false;
  const [year, month, day] = text.slice(0, 10).split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

class Refused extends Error {
  constructor(readonly problem: CfdiProblem) {
    super(problem);
  }
}

const refuse = (problem: CfdiProblem): never => {
  throw new Refused(problem);
};

function cents(text: string | undefined): number {
  const match = text === undefined ? null : AMOUNT.exec(text);
  if (match === null) return refuse("amount");
  const decimals = (match[2] ?? "").padEnd(2, "0");
  if (/[^0]/.test(decimals.slice(2))) return refuse("amount");
  return Number(match[1]) * 100 + Number(decimals.slice(0, 2));
}

const childrenOf = (node: XmlNode, name: string, ns = CFD) => node.children.filter((c) => c.ns === ns && c.name === name);

function only(node: XmlNode, name: string): XmlNode {
  const found = childrenOf(node, name);
  return found.length === 1 ? found[0]! : refuse("shape");
}

function atMostOne(node: XmlNode, name: string): XmlNode | null {
  const found = childrenOf(node, name);
  return found.length > 1 ? refuse("shape") : (found[0] ?? null);
}

function text(node: XmlNode, attr: string): string {
  const value = node.attrs[attr];
  return value === undefined || value.trim() === "" ? refuse("shape") : value;
}

const optional = (node: XmlNode, attr: string): string | null => {
  const value = node.attrs[attr]?.trim();
  return value === undefined || value === "" ? null : value;
};

function count(node: XmlNode, ns: string, name: string): number {
  return (node.ns === ns && node.name === name ? 1 : 0) + node.children.reduce((sum, c) => sum + count(c, ns, name), 0);
}

function taxes(root: XmlNode): { vat: number; income: number; vatWithheld: number } {
  const block = atMostOne(root, "Impuestos");
  if (block === null) return { vat: 0, income: 0, vatWithheld: 0 };
  let vat = 0;
  for (const group of childrenOf(block, "Traslados")) {
    for (const transfer of group.children) {
      if (transfer.ns !== CFD || transfer.name !== "Traslado") continue;
      if (transfer.attrs.Impuesto !== "002") refuse("unsupported_tax");
      const factor = transfer.attrs.TipoFactor;
      if (factor === "Exento") {
        if (transfer.attrs.Importe !== undefined) refuse("shape");
      } else if (factor === "Tasa") {
        vat += cents(transfer.attrs.Importe);
      } else {
        refuse("unsupported_tax");
      }
    }
  }
  let income = 0;
  let vatWithheld = 0;
  for (const group of childrenOf(block, "Retenciones")) {
    for (const withheld of group.children) {
      if (withheld.ns !== CFD || withheld.name !== "Retencion") continue;
      const amount = cents(withheld.attrs.Importe);
      if (withheld.attrs.Impuesto === "001") income += amount;
      else if (withheld.attrs.Impuesto === "002") vatWithheld += amount;
      else refuse("unsupported_tax");
    }
  }
  if (childrenOf(block, "Traslados").length > 1 || childrenOf(block, "Retenciones").length > 1) refuse("shape");
  const transferred = block.attrs.TotalImpuestosTrasladados;
  const retained = block.attrs.TotalImpuestosRetenidos;
  if (transferred !== undefined && cents(transferred) !== vat) refuse("shape");
  if (retained !== undefined && cents(retained) !== income + vatWithheld) refuse("shape");
  return { vat, income, vatWithheld };
}

function stamp(root: XmlNode): XmlNode {
  if (count(root, TFD, "TimbreFiscalDigital") !== 1) return refuse("no_stamp");
  const inside = childrenOf(root, "Complemento").flatMap((c) => childrenOf(c, "TimbreFiscalDigital", TFD));
  const found = inside.length === 1 ? inside[0]! : refuse("no_stamp");
  if (!UUID.test(found.attrs.UUID ?? "") || !isDateTime(found.attrs.FechaTimbrado)) refuse("no_stamp");
  return found;
}

/** El CFDI de un árbol, o por qué no se lee. Nunca lanza. */
export function readCfdi(root: XmlNode): CfdiReading {
  try {
    if (root.ns !== CFD || root.name !== "Comprobante" || root.attrs.Version !== "4.0") refuse("not_cfdi");
    if (count(root, CFD, "Comprobante") !== 1) refuse("shape");
    if (root.attrs.TipoDeComprobante !== "I") refuse("not_income");
    if (root.attrs.Moneda !== "MXN") refuse("not_mxn");
    const issuedAt = text(root, "Fecha");
    if (!isDateTime(issuedAt)) refuse("shape");
    const subtotalCents = cents(root.attrs.SubTotal);
    const totalCents = cents(root.attrs.Total);
    if (root.attrs.Descuento !== undefined && cents(root.attrs.Descuento) !== 0) refuse("discount");
    const issuer = only(root, "Emisor");
    const receiver = only(root, "Receptor");
    const { vat, income, vatWithheld } = taxes(root);
    const timbre = stamp(root);
    return {
      kind: "ok",
      facts: {
        uuid: timbre.attrs.UUID!.toLowerCase(),
        series: optional(root, "Serie"),
        folio: optional(root, "Folio"),
        issuedAt,
        stampedAt: timbre.attrs.FechaTimbrado!,
        issuerRfc: text(issuer, "Rfc"),
        issuerName: text(issuer, "Nombre"),
        issuerRegime: text(issuer, "RegimenFiscal"),
        receiverRfc: text(receiver, "Rfc"),
        receiverRegime: optional(receiver, "RegimenFiscalReceptor"),
        use: optional(receiver, "UsoCFDI"),
        paymentMethod: optional(root, "MetodoPago"),
        subtotalCents,
        vatCents: vat,
        incomeTaxWithheldCents: income,
        vatWithheldCents: vatWithheld,
        totalCents,
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { kind: "problem", problem: error.problem };
    throw error;
  }
}

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const DOCTYPE = ascii("<!DOCTYPE");
const ENTITY = ascii("<!ENTITY");

/** ¿Aparece esa marca, sin importar mayúsculas? Solo letras ASCII: comparar en minúsculas es poner el bit 0x20. */
function contains(bytes: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      const a = bytes[i + j]!;
      const b = needle[j]!;
      const letter = (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
      if (letter ? (a | 0x20) !== (b | 0x20) : a !== b) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Lo que se rechaza por los bytes, antes de que ningún lector los vea: un `DOCTYPE` o una entidad declarada (la bomba de entidades
 * vive ahí), UTF-16 (con marca o con bytes nulos) y lo que pasa del tope. La marca de UTF-8 sí se acepta: muchos facturadores la ponen.
 */
export function cfdiBytesProblem(bytes: Uint8Array): CfdiBytesProblem | null {
  if (bytes.length === 0) return "empty";
  if (bytes.length > CFDI_MAX_BYTES) return "too_large";
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) || bytes.includes(0)) return "encoding";
  if (contains(bytes, DOCTYPE) || contains(bytes, ENTITY)) return "doctype";
  return null;
}
