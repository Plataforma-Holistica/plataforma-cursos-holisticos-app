import { describe, expect, it } from "vitest";

import { parseXml } from "./parse";

// El árbol del XML de una factura (T-604). Lo que llega lo escribió el maestro o su facturador, y se lee como hostil: cualquier cosa
// que no sea XML bien formado, en UTF-8, sin DTD ni instrucciones, y dentro de los topes, es nulo.

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string, limits?: Parameters<typeof parseXml>[1]) => parseXml(bytes(text), limits);

describe("un XML bien formado", () => {
  it("da sus elementos con su espacio de nombres y sus atributos sin prefijo", () => {
    const root = parse(
      '<?xml version="1.0" encoding="UTF-8"?><c:A xmlns:c="urn:a" xmlns:x="urn:x" x:skip="1" B="2"><c:C D="3 &amp; 4"/><E xmlns="urn:e"/><!-- nota --></c:A>',
    );
    expect(root).toEqual({
      ns: "urn:a",
      name: "A",
      attrs: { B: "2" },
      children: [
        { ns: "urn:a", name: "C", attrs: { D: "3 & 4" }, children: [] },
        { ns: "urn:e", name: "E", attrs: {}, children: [] },
      ],
    });
  });

  it("con la marca de UTF-8, también", () => {
    expect(parseXml(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("<A/>")]))?.name).toBe("A");
  });

  it("un atributo llamado __proto__ no le cambia nada a nadie", () => {
    const root = parse('<A __proto__="x" constructor="y"/>');
    expect(Object.getPrototypeOf(root?.attrs)).toBeNull();
    expect(root?.attrs.__proto__).toBe("x");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("lo que no se lee", () => {
  it.each([
    ["truncado", "<A><B></A>"],
    ["sin cerrar", "<A><B/>"],
    ["dos raíces", "<A/><B/>"],
    ["texto suelto", "hola"],
    ["un prefijo sin declarar", "<c:A/>"],
    ["una entidad que no existe", "<A B='&x;'/>"],
    ["un DOCTYPE", "<!DOCTYPE A><A/>"],
    ["un DOCTYPE con entidades", "<!DOCTYPE A [<!ENTITY x 'y'>]><A B='&x;'/>"],
    ["una entidad externa", '<!DOCTYPE A [<!ENTITY x SYSTEM "file:///etc/passwd">]><A>&x;</A>'],
    ["una instrucción", '<?xml-stylesheet href="a"?><A/>'],
    ["otra codificación", '<?xml version="1.0" encoding="ISO-8859-1"?><A/>'],
    ["un atributo repetido", "<A B='1' B='2'/>"],
    ["vacío", ""],
  ])("%s", (_label, text) => {
    expect(parse(text)).toBeNull();
  });

  it("bytes que no son UTF-8", () => {
    expect(parseXml(new Uint8Array([0x3c, 0x41, 0x20, 0x42, 0x3d, 0x22, 0xff, 0x22, 0x2f, 0x3e]))).toBeNull();
  });

  it("más hondo que el tope", () => {
    const deep = (n: number) => "<A>".repeat(n) + "</A>".repeat(n);
    expect(parse(deep(4), { maxDepth: 4, maxElements: 100, maxAttributes: 10 })).not.toBeNull();
    expect(parse(deep(5), { maxDepth: 4, maxElements: 100, maxAttributes: 10 })).toBeNull();
  });

  it("más elementos que el tope", () => {
    const wide = (n: number) => `<A>${"<B/>".repeat(n - 1)}</A>`;
    expect(parse(wide(10), { maxDepth: 4, maxElements: 10, maxAttributes: 10 })).not.toBeNull();
    expect(parse(wide(11), { maxDepth: 4, maxElements: 10, maxAttributes: 10 })).toBeNull();
  });

  it("más atributos que el tope", () => {
    const attrs = (n: number) => `<A ${Array.from({ length: n }, (_, i) => `a${i}="1"`).join(" ")}/>`;
    expect(parse(attrs(3), { maxDepth: 4, maxElements: 10, maxAttributes: 3 })).not.toBeNull();
    expect(parse(attrs(4), { maxDepth: 4, maxElements: 10, maxAttributes: 3 })).toBeNull();
  });
});
