/**
 * Un espacio entre dos piezas de texto. No es un texto visible, y por eso no vive en el
 * catálogo. Va como nodo aparte: dentro de una pieza, el espacio del borde se pierde al
 * calcular el nombre accesible.
 */
export const SPACE = " ";

/** Une clases y descarta las que no aplican. Las clases se escriben completas, nunca armadas. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
