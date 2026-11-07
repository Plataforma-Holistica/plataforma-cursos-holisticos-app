import "server-only";

// El cuerpo crudo de una petición, con tope (T-303). La firma de un aviso va sobre los bytes tal como llegaron: nada lo convierte a JSON antes. Se lee por partes y
// se deja de leer al pasar el tope, para no cargar a la memoria lo que alguien mande de más.

/** Los bytes del cuerpo, o nulo si pasa de `max`. */
export async function readCappedBody(request: Request, max: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}
