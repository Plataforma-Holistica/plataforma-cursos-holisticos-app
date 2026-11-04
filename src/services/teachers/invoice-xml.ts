import "server-only";

import { createHash } from "node:crypto";

import { parseXml } from "@/adapters/xml/parse";
import { cfdiBytesProblem, readCfdi, type CfdiBytesProblem, type CfdiFacts, type CfdiProblem } from "@/domain/fiscal/cfdi";

// El XML de la factura del maestro, de los bytes a lo leído (T-604). En ese orden: los bytes (sin DTD, en UTF-8, dentro del tope), el
// árbol (el adaptador, con sus topes) y el CFDI. La huella es de los bytes tal como llegaron, y la guarda la base.

export type InvoiceXmlProblem = CfdiBytesProblem | CfdiProblem | "not_xml";

export type InvoiceXmlReading = { kind: "ok"; facts: CfdiFacts; sha256: string } | { kind: "problem"; problem: InvoiceXmlProblem };

export function readInvoiceXml(bytes: Uint8Array): InvoiceXmlReading {
  const early = cfdiBytesProblem(bytes);
  if (early !== null) return { kind: "problem", problem: early };
  const root = parseXml(bytes);
  if (root === null) return { kind: "problem", problem: "not_xml" };
  const reading = readCfdi(root);
  if (reading.kind === "problem") return reading;
  return { kind: "ok", facts: reading.facts, sha256: createHash("sha256").update(bytes).digest("hex") };
}
