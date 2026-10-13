import "server-only";

// El código QR del segundo factor. Supabase Auth lo entrega como un SVG al dar de alta un
// factor de aplicación de códigos, con la misma clave que manda en texto dentro. Aquí se
// decide qué de eso se le pasa a una pantalla: un SVG hecho solo de lo que se espera, o nada.
//
// Va por lista de permitidos, no de prohibidos. Lo que Auth manda (medido contra v2.197.0)
// es una declaración de XML, un comentario, un `<svg>` y miles de `<rect>` con posición,
// tamaño y un estilo de relleno. Cualquier otra cosa (otro elemento, otro atributo, texto,
// algo después del cierre) no se entrega: la pantalla pinta entonces solo la clave en
// texto, y la prueba de integración que mide el QR de Auth avisa.
//
// Cada pieza se reconoce desde donde terminó la anterior, sin volver atrás: el tiempo crece
// con el tamaño y no con la forma de lo que llegue.

/** Lo más que puede pesar. El que manda Auth pesa unos 360 KB. */
export const QR_MAX_LENGTH = 1_000_000;

// Letras, dígitos y la puntuación de un tamaño, un color, un espacio de nombres o un
// estilo de relleno. Sin comillas, paréntesis, ampersand ni signos de mayor o menor.
const VALUE = '"[A-Za-z0-9 .,:;/#%-]*"';
const SVG_ATTRIBUTES = "width|height|viewBox|version|xmlns|xmlns:xlink|preserveAspectRatio|shape-rendering";
const RECT_ATTRIBUTES = "x|y|width|height|rx|ry|fill|stroke|stroke-width|style";

const SPACE = /\s+/y;
const DECLARATION = /<\?xml version="1\.[01]"(?: encoding="[A-Za-z0-9-]+")?\s*\?>/y;
const COMMENT = /<!--[^<>]*-->/y;
const OPENING = new RegExp(`<svg(?:\\s+(?:${SVG_ATTRIBUTES})=${VALUE})*\\s*>`, "y");
const RECT = new RegExp(`<rect(?:\\s+(?:${RECT_ATTRIBUTES})=${VALUE})*\\s*/>`, "y");
const CLOSING = /<\/svg>/y;

/** Si esa pieza está justo en esa posición, dónde termina; si no, la misma posición. */
function past(piece: RegExp, text: string, from: number): number {
  piece.lastIndex = from;
  return piece.test(text) ? piece.lastIndex : from;
}

/** Salta espacios y las piezas que se le digan, las veces que aparezcan. */
function skip(text: string, from: number, ...pieces: RegExp[]): number {
  let at = from;
  for (;;) {
    let next = past(SPACE, text, at);
    for (const piece of pieces) next = past(piece, text, next);
    if (next === at) return at;
    at = next;
  }
}

/** La imagen del código QR, si lo que Auth mandó es un SVG hecho solo de lo esperado; si no, nulo. */
export function qrImage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > QR_MAX_LENGTH) return null;

  // Antes del dibujo: la declaración, una sola vez y al principio, y comentarios.
  let at = past(DECLARATION, value, past(SPACE, value, 0));
  at = skip(value, at, COMMENT);
  const opened = past(OPENING, value, at);
  if (opened === at) return null;

  // El dibujo: solo rectángulos.
  at = skip(value, opened, RECT);
  const closed = past(CLOSING, value, at);
  if (closed === at) return null;

  // Y después del cierre, nada.
  return past(SPACE, value, closed) === value.length ? value : null;
}
