// El código del segundo factor, como lo teclea o lo pega una persona (RF-106): seis dígitos
// de su aplicación de códigos.
//
// Lo usan el formulario, al salir del campo, y los servicios del equipo, antes de
// preguntarle a Supabase Auth. Un código sin forma no es un intento: no llega a Auth, y
// por eso no cuenta en el freno de los códigos. Tiene que ser la misma regla en los dos
// lados.

export const SECOND_FACTOR_CODE_LENGTH = 6;

// Dígitos ASCII, y nada más: Auth no acepta los de otros alfabetos.
const CODE = /^[0-9]{6}$/;

export type SecondFactorCodeResult =
  | { ok: true; /** Sin espacios: lo que se le manda a Auth. */ code: string }
  | { ok: false; reason: "empty" | "malformed" };

/**
 * Lee lo que llegó en el campo del código. Las aplicaciones lo muestran partido en dos
 * («123 456») y al pegarlo se cuelan espacios: se quitan todos antes de mirar su forma.
 */
export function parseSecondFactorCode(input: unknown): SecondFactorCodeResult {
  if (input === null || input === undefined) return { ok: false, reason: "empty" };
  if (typeof input !== "string") return { ok: false, reason: "malformed" };
  const code = input.replace(/\s/g, "");
  if (code === "") return { ok: false, reason: "empty" };
  return CODE.test(code) ? { ok: true, code } : { ok: false, reason: "malformed" };
}
