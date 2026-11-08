// El texto de un comentario y del seudónimo (RF-801, RF-808; T-501): el único criterio antes de la base. Lo usan el
// servicio, antes de preguntarle a la base, y la pantalla, para decirlo en su campo sin perder lo escrito.
//
// Es `private.comment_text_ok` (`t501_comentarios`) escrita en TypeScript: la regla del borrador (`draft_text_ok`), salvo
// una sola unión de ancho cero (U+200D) o no unión (U+200C) entre dos caracteres que no son espacio ni otro carácter de
// formato, que arman los emoji compuestos. Las listas son las de la base, copiadas, y no `\p{Cf}`: la de la base tiene
// puntos sin asignar que JavaScript no da por formato (U+2065, U+E0000, de U+E0002 a U+E001F). La integración 102 compara
// las dos en todos los puntos de código: si una cambia, la otra también.

/** El tope de un comentario (decisión mía sin confirmar, de la primera solicitud). */
export const COMMENT_MAX = 4000;
export const PSEUDONYM_MIN = 2;
export const PSEUDONYM_MAX = 40;

/** Lo que se acepta revisar: más largo es «demasiado largo» sin normalizarlo. */
const INPUT_MAX_FACTOR = 4;

// Los espacios de las puntas, los mismos que quita `trim()`.
const EDGE = /^[\u{9}-\u{d}\u{20}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]|[\u{9}-\u{d}\u{20}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]$/u;
// Los de control. El nulo y los suplentes sueltos no llegan a la base: el controlador los rechaza o los cambia.
const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}\u{d800}-\u{dfff}]/u;
const CONTROL_MULTILINE = /[\u{0}-\u{9}\u{b}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}\u{d800}-\u{dfff}]/u;
// Los de formato, la lista de `draft_text_ok`.
const FORMAT =
  /[\u{ad}\u{600}-\u{605}\u{61c}\u{6dd}\u{70f}\u{890}\u{891}\u{8e2}\u{180e}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{feff}\u{fff9}-\u{fffb}\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/u;
// La unión que se deja pasar: entre dos caracteres que no son espacio ni de formato (los de U+2000 a U+200F).
const JOINER =
  /(?<=[^\u{9}-\u{d}\u{20}\u{a0}\u{1680}\u{2000}-\u{200f}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])[\u{200c}\u{200d}](?=[^\u{9}-\u{d}\u{20}\u{a0}\u{1680}\u{2000}-\u{200f}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])/gu;

const codePoints = (text: string): number => [...text].length;

/** `draft_text_ok`: de 1 a `max`, en NFC, sin espacios en las puntas, sin control ni formato. */
function draftTextOk(text: string, max: number, multiline: boolean): boolean {
  const length = codePoints(text);
  return (
    length >= 1 &&
    length <= max &&
    text.normalize("NFC") === text &&
    !EDGE.test(text) &&
    !(multiline ? CONTROL_MULTILINE : CONTROL).test(text) &&
    !FORMAT.test(text)
  );
}

/**
 * `comment_text_ok`, tal cual: el largo con las uniones, en NFC, y la regla del borrador sobre el texto sin las uniones
 * que se dejan pasar (también en NFC: quitar una unión puede dejar dos caracteres que se componen).
 */
export function commentTextOk(text: string, max: number, multiline: boolean): boolean {
  if (codePoints(text) > max || text.normalize("NFC") !== text) return false;
  return draftTextOk(text.replace(JOINER, ""), max, multiline);
}

export type CommentTextResult =
  | { ok: true; /** Lo que se manda: en NFC y sin espacios en las puntas. */ text: string }
  | { ok: false; reason: "empty" | "too_short" | "too_long" | "invalid" };

function parse(input: string | null, max: number, multiline: boolean): CommentTextResult {
  const raw = input ?? "";
  if (raw.length > max * INPUT_MAX_FACTOR) return { ok: false, reason: "too_long" };
  // Un formulario sin JavaScript manda los saltos como CRLF, y la regla rechaza el retorno de carro.
  const text = (multiline ? raw.replace(/\r\n?/g, "\n") : raw).replace(/\t/g, " ").normalize("NFC").trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (codePoints(text) > max) return { ok: false, reason: "too_long" };
  return commentTextOk(text, max, multiline) ? { ok: true, text } : { ok: false, reason: "invalid" };
}

/** El texto de un comentario o de una respuesta: hasta 4 000, en varias líneas. */
export const parseCommentBody = (input: string | null): CommentTextResult => parse(input, COMMENT_MAX, true);

/** El seudónimo (RF-808): de 2 a 40, en una línea. */
export function parsePseudonym(input: string | null): CommentTextResult {
  const result = parse(input, PSEUDONYM_MAX, false);
  if (result.ok && codePoints(result.text) < PSEUDONYM_MIN) return { ok: false, reason: "too_short" };
  return result;
}
