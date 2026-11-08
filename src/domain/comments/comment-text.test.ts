import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { COMMENT_MAX, commentTextOk, parseCommentBody, parsePseudonym, PSEUDONYM_MAX, PSEUDONYM_MIN } from "./comment-text";

// El texto de un comentario y del seudónimo (RF-801, RF-808): la regla de `private.comment_text_ok`, que la integración 102
// compara con la base en todos los puntos de código. Aquí, los casos que se nombran y la normalización.

const ZWJ = "\u{200d}";
const ZWNJ = "\u{200c}";
const FAMILY = `\u{1f9d8}${ZWJ}\u{2640}\u{fe0f}`;

describe("commentTextOk: la regla de la base, tal cual", () => {
  it("los largos se cuentan por punto de código", () => {
    expect(commentTextOk("a".repeat(4000), 4000, true)).toBe(true);
    expect(commentTextOk("a".repeat(4001), 4000, true)).toBe(false);
    expect(commentTextOk("\u{1f600}".repeat(4000), 4000, true)).toBe(true);
    expect(commentTextOk("", 4000, true)).toBe(false);
  });

  it("sin espacios en las puntas, también los de Unicode", () => {
    for (const space of [" ", "\t", "\n", "\u{a0}", "\u{1680}", "\u{2000}", "\u{200a}", "\u{2028}", "\u{202f}", "\u{205f}", "\u{3000}", "\u{feff}"]) {
      expect(commentTextOk(`${space}hola`, 40, true)).toBe(false);
      expect(commentTextOk(`hola${space}`, 40, true)).toBe(false);
    }
    expect(commentTextOk("ho la", 40, false)).toBe(true);
  });

  it("los saltos de línea, solo en el texto de varias líneas, y nunca el retorno de carro", () => {
    expect(commentTextOk("una\ndos", 40, true)).toBe(true);
    expect(commentTextOk("una\ndos", 40, false)).toBe(false);
    expect(commentTextOk("una\r\ndos", 40, true)).toBe(false);
    for (const control of ["\u{1}", "\t", "\u{b}", "\u{1f}", "\u{7f}", "\u{85}", "\u{9f}", "\u{2028}", "\u{2029}"]) {
      expect(commentTextOk(`a${control}b`, 40, true)).toBe(false);
    }
  });

  it("en NFC, antes y después de quitar la unión", () => {
    expect(commentTextOk("e\u{301}", 40, false)).toBe(false);
    expect(commentTextOk("\u{e9}", 40, false)).toBe(true);
    // La unión impedía componer: quitada, ya no es NFC, y la base la rechaza.
    expect(commentTextOk(`e${ZWJ}\u{301}`, 40, false)).toBe(false);
  });

  it("una sola unión o no unión entre dos caracteres que no son espacio ni formato", () => {
    expect(commentTextOk(`Ana ${FAMILY}`, 40, false)).toBe(true);
    expect(commentTextOk(`Mehr${ZWNJ}dad`, 40, false)).toBe(true);
    expect(commentTextOk(`Ana${ZWJ}`, 40, false)).toBe(false);
    expect(commentTextOk(`${ZWJ}Ana`, 40, false)).toBe(false);
    expect(commentTextOk(`Ana ${ZWJ}x`, 40, false)).toBe(false);
    expect(commentTextOk(`Ana\u{a0}${ZWJ}x`, 40, false)).toBe(false);
    expect(commentTextOk(`Ana${ZWJ}${ZWJ}x`, 40, false)).toBe(false);
    expect(commentTextOk(`Ana${ZWJ}${ZWNJ}x`, 40, false)).toBe(false);
    expect(commentTextOk(`una${ZWJ}\ndos`, 40, true)).toBe(false);
    // La unión cuenta para el largo.
    expect(commentTextOk(`${"a".repeat(20)}${ZWJ}${"a".repeat(20)}`, 40, false)).toBe(false);
  });

  it("los caracteres de formato de la lista de la base, también los que JavaScript no tiene por formato", () => {
    for (const format of ["\u{ad}", "\u{600}", "\u{61c}", "\u{200b}", "\u{200e}", "\u{202e}", "\u{2060}", "\u{2065}", "\u{206f}", "\u{feff}", "\u{fffb}",
      "\u{110bd}", "\u{13430}", "\u{1bca0}", "\u{1d173}", "\u{e0000}", "\u{e0001}", "\u{e0002}", "\u{e007f}"]) {
      expect(commentTextOk(`a${format}b`, 40, true)).toBe(false);
    }
    expect(commentTextOk("a\u{e0080}b", 40, true)).toBe(true);
  });

  it("un suplente suelto no pasa", () => {
    expect(commentTextOk("a\u{d800}b", 40, true)).toBe(false);
    expect(commentTextOk("a\u{dfff}", 40, true)).toBe(false);
    expect(commentTextOk("a\u{0}b", 40, true)).toBe(false);
  });
});

describe("parseCommentBody", () => {
  it("normaliza como el borrador: los saltos, el tabulador, NFC y las puntas", () => {
    expect(parseCommentBody("  una\r\ndos\rtres\tcuatro  ")).toEqual({ ok: true, text: "una\ndos\ntres cuatro" });
    expect(parseCommentBody("e\u{301}")).toEqual({ ok: true, text: "\u{e9}" });
  });

  it("vacío, demasiado largo o con lo que la base rechaza", () => {
    expect(parseCommentBody(null)).toEqual({ ok: false, reason: "empty" });
    expect(parseCommentBody(" \n ")).toEqual({ ok: false, reason: "empty" });
    expect(COMMENT_MAX).toBe(4000);
    expect(parseCommentBody("a".repeat(COMMENT_MAX))).toEqual({ ok: true, text: "a".repeat(COMMENT_MAX) });
    expect(parseCommentBody("a".repeat(COMMENT_MAX + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(parseCommentBody("a".repeat(COMMENT_MAX * 5))).toEqual({ ok: false, reason: "too_long" });
    expect(parseCommentBody("a\u{202e}b")).toEqual({ ok: false, reason: "invalid" });
    expect(parseCommentBody(`hola ${FAMILY}`)).toEqual({ ok: true, text: `hola ${FAMILY}` });
  });
});

describe("parsePseudonym", () => {
  it("de 2 a 40, en una línea", () => {
    expect([PSEUDONYM_MIN, PSEUDONYM_MAX]).toEqual([2, 40]);
    expect(parsePseudonym("  Anita ")).toEqual({ ok: true, text: "Anita" });
    expect(parsePseudonym("A")).toEqual({ ok: false, reason: "too_short" });
    expect(parsePseudonym("")).toEqual({ ok: false, reason: "empty" });
    expect(parsePseudonym("a".repeat(41))).toEqual({ ok: false, reason: "too_long" });
    expect(parsePseudonym("An\na")).toEqual({ ok: false, reason: "invalid" });
    expect(parsePseudonym(`Ana ${FAMILY}`)).toEqual({ ok: true, text: `Ana ${FAMILY}` });
  });
});

describe("propiedades", () => {
  it("lo que pasa es lo que la regla de la base acepta, y no cambia al volver a revisarlo", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), (input) => {
        const body = parseCommentBody(input);
        if (body.ok) {
          expect(commentTextOk(body.text, COMMENT_MAX, true)).toBe(true);
          expect(parseCommentBody(body.text)).toEqual(body);
        }
        const name = parsePseudonym(input);
        if (name.ok) {
          expect(commentTextOk(name.text, PSEUDONYM_MAX, false)).toBe(true);
          expect([...name.text].length).toBeGreaterThanOrEqual(PSEUDONYM_MIN);
        }
      }),
    );
  });
});
