import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { legalBlocks } from "./blocks";

describe("el cuerpo de un texto legal, en bloques", () => {
  it("separa títulos y párrafos", () => {
    const body = ["# Términos", "", "Primer párrafo,", "en dos renglones.", "", "## Pagos", "", "Segundo párrafo."].join("\n");
    expect(legalBlocks(body)).toEqual([
      { kind: "heading", level: 1, text: "Términos" },
      { kind: "paragraph", text: "Primer párrafo, en dos renglones." },
      { kind: "heading", level: 2, text: "Pagos" },
      { kind: "paragraph", text: "Segundo párrafo." },
    ]);
  });

  it("un título corta el párrafo aunque no haya renglón en blanco", () => {
    expect(legalBlocks("Uno.\n## Dos\nTres.")).toEqual([
      { kind: "paragraph", text: "Uno." },
      { kind: "heading", level: 2, text: "Dos" },
      { kind: "paragraph", text: "Tres." },
    ]);
  });

  it("acepta los saltos de renglón de Windows y los espacios de sobra", () => {
    expect(legalBlocks("  # Título  \r\n\r\n  Texto.  \r\n")).toEqual([
      { kind: "heading", level: 1, text: "Título" },
      { kind: "paragraph", text: "Texto." },
    ]);
  });

  it("un nivel más hondo que el tercero queda en el tercero", () => {
    expect(legalBlocks("### Tres\n\n##### Cinco")).toEqual([
      { kind: "heading", level: 3, text: "Tres" },
      { kind: "heading", level: 3, text: "Cinco" },
    ]);
  });

  it("lo que no es un título es texto: un numeral sin espacio, o solo numerales", () => {
    expect(legalBlocks("#sin espacio\n\n#\n\n## ")).toEqual([
      { kind: "paragraph", text: "#sin espacio" },
      { kind: "paragraph", text: "#" },
      { kind: "paragraph", text: "##" },
    ]);
  });

  it("no interpreta nada más: lo que parezca marcado sale tal cual, como texto", () => {
    const body = '<script>alert(1)</script>\n\n[enlace](https://otro.example) y **negritas**';
    expect(legalBlocks(body)).toEqual([
      { kind: "paragraph", text: "<script>alert(1)</script>" },
      { kind: "paragraph", text: "[enlace](https://otro.example) y **negritas**" },
    ]);
  });

  it("un cuerpo vacío no da bloques", () => {
    expect(legalBlocks("")).toEqual([]);
    expect(legalBlocks(" \n\r\n \n")).toEqual([]);
  });

  it("nunca pierde ni inventa texto", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        const squash = (text: string) => text.replace(/[\s#]+/g, "");
        expect(squash(legalBlocks(body).map((block) => block.text).join(""))).toBe(squash(body));
        for (const block of legalBlocks(body)) expect(block.text).toBe(block.text.trim());
      }),
    );
  });
});
