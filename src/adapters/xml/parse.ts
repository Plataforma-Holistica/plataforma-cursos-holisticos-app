import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";

import type { XmlNode } from "@/domain/fiscal/cfdi";

// El XML de la factura del maestro, convertido en árbol (T-604). Lo que llega se lee como hostil, con `saxes` (decisión mía sin
// confirmar: sin avisos de seguridad y con una sola dependencia, frente a los siete avisos de `fast-xml-parser` en 2026). `saxes` no
// expande entidades de un DTD; además aquí un `DOCTYPE`, una instrucción o una codificación que no sea UTF-8 detienen la lectura, y el
// dominio ya rechazó esos bytes antes (`cfdiBytesProblem`). Topes de profundidad, de elementos y de atributos. Nunca lanza: lo que no
// se pudo leer es nulo, sin decir por qué, porque el porqué lo escribió quien mandó el archivo.

export interface XmlLimits {
  maxDepth: number;
  maxElements: number;
  maxAttributes: number;
}

/** Holgados para un CFDI con muchos conceptos; una factura de honorarios trae decenas de elementos. */
export const CFDI_XML_LIMITS: XmlLimits = { maxDepth: 16, maxElements: 2_000, maxAttributes: 64 };

class Stop extends Error {}

const stop = (): never => {
  throw new Stop();
};

interface Building {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: Building[];
}

export function parseXml(bytes: Uint8Array, limits: XmlLimits = CFDI_XML_LIMITS): XmlNode | null {
  let text: string;
  try {
    // `fatal`: un byte que no es UTF-8 detiene, en vez de volverse un carácter de reemplazo. La marca de UTF-8 se quita sola.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: Building[] = [];
  let root: Building | null = null;
  let elements = 0;

  parser.on("error", stop);
  parser.on("doctype", stop);
  parser.on("processinginstruction", stop);
  parser.on("xmldecl", (decl) => {
    if (decl.encoding !== undefined && decl.encoding.toUpperCase() !== "UTF-8") stop();
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    elements += 1;
    const attributes = Object.values(tag.attributes as Record<string, SaxesAttributeNS>);
    if (elements > limits.maxElements || stack.length + 1 > limits.maxDepth || attributes.length > limits.maxAttributes) stop();
    // Sin prototipo: un atributo `__proto__` es solo un atributo.
    const attrs = Object.create(null) as Record<string, string>;
    for (const attribute of attributes) {
      if (attribute.prefix === "" && attribute.name !== "xmlns") attrs[attribute.local] = attribute.value;
    }
    const node: Building = { ns: tag.uri, name: tag.local, attrs, children: [] };
    const parent = stack.at(-1);
    if (parent === undefined) root = node;
    else parent.children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });

  try {
    parser.write(text).close();
  } catch {
    return null;
  }
  return stack.length === 0 ? root : null;
}
