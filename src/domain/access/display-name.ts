// El nombre que la persona escribe (RF-109): el único criterio de «nombre válido».
//
// Lo usan la guarda de sesión, para decidir si a una cuenta le falta el nombre, y los
// formularios que lo piden (PA-14 y PA-15). Tiene que ser el mismo: si la guarda dijera
// «falta» a un nombre que el formulario acepta, la persona quedaría dando vueltas.

/** El de la base: `char_length(display_name) between 1 and 120`, que cuenta caracteres. */
export const DISPLAY_NAME_MAX_LENGTH = 120;

const CONTROL = /\p{Cc}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

export type DisplayNameResult =
  | { ok: true; /** Sin espacios en los extremos: lo que se guarda. */ name: string }
  | { ok: false; reason: "empty" | "too_long" | "invalid" };

export function parseDisplayName(input: string | null): DisplayNameResult {
  const name = (input ?? "").trim();
  if (name === "") return { ok: false, reason: "empty" };
  if ([...name].length > DISPLAY_NAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  // Sin caracteres de control (un salto de línea rompería donde se muestre), y con al menos
  // una letra o un número: un nombre de puros signos o de caracteres invisibles se vería vacío.
  if (CONTROL.test(name) || !LETTER_OR_NUMBER.test(name)) return { ok: false, reason: "invalid" };
  return { ok: true, name };
}
