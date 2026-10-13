import "server-only";

// El código QR del segundo factor. Supabase Auth lo entrega como un SVG al dar de alta un
// factor de aplicación de códigos, con la misma clave que manda en texto dentro. Aquí se
// decide qué de eso se le pasa a una pantalla: un SVG que solo dibuja, o nada.

/** Lo más que puede pesar. El que manda Auth pesa unos 360 KB. */
export const QR_MAX_LENGTH = 1_000_000;

// Un SVG, con su declaración de XML y sus comentarios delante si los trae.
const SVG = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/;
// Lo que un dibujo no necesita. Se pinta como imagen, donde nada de esto correría: es una
// segunda barrera, por si algún día alguien lo incrusta de otra manera.
const NOT_DRAWING = /<script|<foreignObject|\son[a-z]+\s*=|javascript:/i;

/** La imagen del código QR, si lo que Auth mandó es un SVG que solo dibuja; si no, nulo. */
export function qrImage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > QR_MAX_LENGTH) return null;
  if (!SVG.test(value) || NOT_DRAWING.test(value)) return null;
  return value;
}
