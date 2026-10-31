import { describe, expect, it } from "vitest";

import { contentMatches, RESOURCE_READ, resourceTypeOf } from "./resource-content";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const join = (...parts: Uint8Array[]) => {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
};

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MP3 = "audio/mpeg";
const M4A = "audio/mp4";

/** El principio de un archivo MP4 con esa marca: 4 bytes de largo, `ftyp` y la marca. */
const mp4 = (brand: string) => join(bytes(0, 0, 0, 0x20), ascii("ftyp"), ascii(brand), bytes(0, 0, 0, 0));
const ZIP_START = join(ascii("PK"), bytes(3, 4), bytes(0, 0, 0, 0, 0, 0, 0, 0));
/** El final de un ZIP: su directorio con esos nombres, y la marca de fin. */
const zipEnd = (...names: string[]) => join(...names.map(ascii), ascii("PK"), bytes(5, 6), bytes(0, 0, 0, 0));

describe("resourceTypeOf: la clase y el tipo salen de la extensión, no de lo que diga el navegador", () => {
  it.each([
    ["guia.pdf", "pdf", PDF, "pdf"],
    ["GUIA.PDF", "pdf", PDF, "pdf"],
    ["apuntes.docx", "doc", DOCX, "docx"],
    ["respira.mp3", "audio", MP3, "mp3"],
    ["respira.m4a", "audio", M4A, "m4a"],
    ["con.puntos.en.el.nombre.pdf", "pdf", PDF, "pdf"],
  ])("%s", (name, kind, mime, extension) => {
    expect(resourceTypeOf(name)).toEqual({ kind, mime, extension });
  });

  it.each(["apuntes.doc", "tabla.xlsx", "video.mp4", "audio.wav", "audio.ogg", "programa.exe", "pdf", ".pdf", "sin-extension", "", "guia.pdf.exe", "guia.pdf "])(
    "«%s» no se admite",
    (name) => {
      expect(resourceTypeOf(name)).toBeNull();
    },
  );
});

describe("contentMatches: el contenido real, por sus primeros bytes", () => {
  describe("PDF", () => {
    it("empieza con %PDF-", () => {
      expect(contentMatches(PDF, ascii("%PDF-1.7\n"), null)).toBe(true);
    });
    it.each([
      ["otro contenido", ascii("<html><body>")],
      ["casi", ascii("%PDF")],
      ["con algo antes", ascii(" %PDF-1.7")],
      ["vacío", new Uint8Array()],
    ])("%s, no", (_name, head) => {
      expect(contentMatches(PDF, head, null)).toBe(false);
    });
  });

  describe("MP3", () => {
    it("con etiqueta ID3", () => {
      expect(contentMatches(MP3, join(ascii("ID3"), bytes(4, 0, 0, 0, 0, 0, 0x10, 0)), null)).toBe(true);
    });
    it.each([
      ["versión inválida", join(ascii("ID3"), bytes(0xff, 0, 0, 0, 0, 0, 0, 0))],
      ["tamaño con el bit alto", join(ascii("ID3"), bytes(4, 0, 0, 0x80, 0, 0, 0, 0))],
      ["solo las tres letras", ascii("ID3 y lo que sea, un texto cualquiera")],
      ["cortada", ascii("ID3")],
    ])("una etiqueta ID3 falsa: %s, no", (_name, head) => {
      expect(contentMatches(MP3, head, null)).toBe(false);
    });
    it("con una cabecera MPEG capa III completa", () => {
      // MPEG-1, capa III, 128 kbps, 44.1 kHz.
      expect(contentMatches(MP3, bytes(0xff, 0xfb, 0x90, 0x00), null)).toBe(true);
      // MPEG-2, capa III.
      expect(contentMatches(MP3, bytes(0xff, 0xf3, 0x90, 0x00), null)).toBe(true);
    });
    it.each([
      ["sin sincronía", bytes(0xff, 0x1b, 0x90, 0x00)],
      ["versión reservada", bytes(0xff, 0xeb, 0x90, 0x00)],
      ["otra capa (AAC o capa I)", bytes(0xff, 0xff, 0x90, 0x00)],
      ["bitrate libre", bytes(0xff, 0xfb, 0x00, 0x00)],
      ["bitrate inválido", bytes(0xff, 0xfb, 0xf0, 0x00)],
      ["frecuencia reservada", bytes(0xff, 0xfb, 0x9c, 0x00)],
      ["cortado", bytes(0xff, 0xfb)],
      ["un PDF", ascii("%PDF-1.7")],
    ])("%s, no", (_name, head) => {
      expect(contentMatches(MP3, head, null)).toBe(false);
    });
  });

  describe("M4A", () => {
    it.each(["M4A ", "M4B "])("marca %s", (brand) => {
      expect(contentMatches(M4A, mp4(brand), null)).toBe(true);
    });
    it.each(["mp42", "isom", "qt  ", "M4V "])("marca %s: puede traer video, no", (brand) => {
      expect(contentMatches(M4A, mp4(brand), null)).toBe(false);
    });
    it("sin ftyp, no", () => {
      expect(contentMatches(M4A, join(bytes(0, 0, 0, 0x20), ascii("moov"), ascii("M4A ")), null)).toBe(false);
    });
    it("cortado, no", () => {
      expect(contentMatches(M4A, bytes(0, 0, 0, 0x20), null)).toBe(false);
    });
  });

  describe("Word", () => {
    const word = zipEnd("[Content_Types].xml", "_rels/.rels", "word/document.xml");
    it("un ZIP con el contenido de un Word", () => {
      expect(contentMatches(DOCX, ZIP_START, word)).toBe(true);
    });
    it.each([
      ["sin [Content_Types].xml", ZIP_START, zipEnd("word/document.xml")],
      ["sin word/document.xml: otro ZIP", ZIP_START, zipEnd("[Content_Types].xml", "xl/workbook.xml")],
      ["con macros", ZIP_START, zipEnd("[Content_Types].xml", "word/document.xml", "word/vbaProject.bin")],
      ["sin el final del ZIP", ZIP_START, join(ascii("[Content_Types].xml"), ascii("word/document.xml"))],
      ["que no empieza como ZIP", ascii("%PDF-1.7"), word],
    ])("%s, no", (_name, head, tail) => {
      expect(contentMatches(DOCX, head, tail)).toBe(false);
    });
    it("los nombres no distinguen mayúsculas: las macros tampoco se esconden así", () => {
      expect(contentMatches(DOCX, ZIP_START, zipEnd("[Content_Types].xml", "word/document.xml", "word/VBAPROJECT.BIN"))).toBe(false);
    });
    it("Word en la web guarda a veces otro nombre", () => {
      expect(contentMatches(DOCX, ZIP_START, zipEnd("[Content_Types].xml", "word/document2.xml"))).toBe(true);
    });
    it("sin leer el final no se puede decir que sí", () => {
      expect(contentMatches(DOCX, ZIP_START, null)).toBe(false);
    });
  });

  it("un tipo que no es de la lista, no", () => {
    expect(contentMatches("application/zip", ZIP_START, null)).toBe(false);
    expect(contentMatches("image/png", ascii("%PDF-1.7"), null)).toBe(false);
  });

  it("cada tipo dice cuánto hay que leer: al final, solo el de Word", () => {
    expect(RESOURCE_READ.head).toBeGreaterThanOrEqual(12);
    expect(RESOURCE_READ.tailOf(DOCX)).toBe(65_557);
    expect(RESOURCE_READ.tailOf(PDF)).toBe(0);
    expect(RESOURCE_READ.tailOf(MP3)).toBe(0);
    expect(RESOURCE_READ.tailOf(M4A)).toBe(0);
  });
});
