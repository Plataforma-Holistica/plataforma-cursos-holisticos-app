// El nombre que la persona escribe (RF-109): el único criterio de «nombre válido».
//
// Lo usan la guarda de sesión, para decidir si a una cuenta le falta el nombre, y los
// formularios que lo piden (PA-14 y PA-15). Tiene que ser el mismo: si la guarda dijera
// «falta» a un nombre que el formulario acepta, la persona quedaría dando vueltas.

/** El de la base: `char_length(display_name) between 1 and 120`, que cuenta caracteres. */
export const DISPLAY_NAME_MAX_LENGTH = 120;

// Lo que no puede ir en un nombre: caracteres de control, separadores de línea y de párrafo
// (romperían donde se muestre), mitades sueltas de un carácter, las marcas que invierten la
// dirección del texto (sirven para disfrazar un nombre), y los invisibles más comunes,
// incluidos los «rellenos» que Unicode clasifica como letras y se ven como un espacio.
// No pretende atrapar todo lo invisible de Unicode: atrapa lo que rompe una pantalla o deja
// un nombre que se ve vacío. Lo que decide si un nombre es apropiado es la moderación.
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}​⁠﻿‪-‮⁦-⁩ᅟᅠㅤﾠ]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

export type DisplayNameResult =
  | { ok: true; /** Sin espacios en los extremos: lo que se guarda. */ name: string }
  | { ok: false; reason: "empty" | "too_long" | "invalid" };

export function parseDisplayName(input: string | null): DisplayNameResult {
  const name = (input ?? "").trim();
  if (name === "") return { ok: false, reason: "empty" };
  if ([...name].length > DISPLAY_NAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  // Y con al menos una letra o un número: un nombre de puros signos no es un nombre.
  if (FORBIDDEN.test(name) || !LETTER_OR_NUMBER.test(name)) return { ok: false, reason: "invalid" };
  return { ok: true, name };
}
