// La regla de la contraseña (TRD §9.2, fila «Registro»; RNF-08).
//
// Mínimo de caracteres y máximo de bytes, sin reglas de composición: no se exige
// mayúscula, número ni símbolo. No se recorta ni se normaliza nada: lo que la persona
// escribió es lo que se le manda a Auth, y normalizar en un camino y no en otro la dejaría
// fuera de su cuenta.
//
// Los dos límites se repiten en otro lado, y por eso van como constantes: el mínimo es el
// `minimum_password_length` de la configuración de Auth, que una prueba compara con este;
// el máximo es de Auth, que guarda la contraseña con un algoritmo que solo lee 72 bytes.

/** Caracteres, contados como puntos de código: un emoji es uno, no dos. */
export const PASSWORD_MIN_LENGTH = 8;
/** Bytes en UTF-8. Auth rechaza el byte 73 (comprobado el 2026-10-09). */
export const PASSWORD_MAX_BYTES = 72;

export type PasswordCheck = { ok: true } | { ok: false; reason: "too_short" | "too_long" | "malformed" };

export function checkPassword(password: string): PasswordCheck {
  let length = 0;
  let bytes = 0;
  for (let index = 0; index < password.length; index += 1) {
    const unit = password.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // Mitad alta de un carácter de dos unidades: tiene que seguirle su mitad baja. Fuera
      // del texto, `charCodeAt` da NaN, que no cae en ningún rango.
      const next = password.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return { ok: false, reason: "malformed" };
      index += 1;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // Una mitad baja suelta: no es texto válido, y cada sistema la codificaría distinto.
      return { ok: false, reason: "malformed" };
    } else if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) {
      // Caracteres de control: nadie los escribe en un campo de contraseña, y hay sistemas
      // que cortan un texto en el primer carácter nulo.
      return { ok: false, reason: "malformed" };
    } else if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    length += 1;
  }
  if (length < PASSWORD_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (bytes > PASSWORD_MAX_BYTES) return { ok: false, reason: "too_long" };
  return { ok: true };
}
