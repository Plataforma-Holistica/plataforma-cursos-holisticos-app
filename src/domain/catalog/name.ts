// El nombre de una práctica o un nivel del catálogo (RF-709, PA-67): el único criterio de
// «nombre válido» antes de la base. Lo usan el servicio, antes de preguntarle a la base, y la
// pantalla, antes de llamar al servicio: así un nombre que no pasa se dice en su campo y no
// se pierde.
//
// La base revisa lo mismo y manda (`private.catalog_name_ok()` y las restricciones de las
// tablas): el nombre en NFC, de 1 a 40 caracteres, sin caracteres de control ni de formato, y
// con al menos una letra o un número de los que dan un slug.

/** El de la base: `char_length(name) between 1 and 40`, que cuenta caracteres. */
export const CATALOG_NAME_MAX_LENGTH = 40;

/**
 * Lo que se acepta revisar. Más largo es «demasiado largo» sin normalizarlo: normalizar un
 * texto desmedido sería trabajo por nada.
 */
const INPUT_MAX_LENGTH = 400;

// Los caracteres de control y los de formato (la categoría Cf: el guion suave, los de ancho
// cero, los que invierten o aíslan la dirección del texto), que no se ven y harían que dos
// nombres iguales no lo parecieran.
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;
// Las marcas de acento que quedan sueltas al descomponer: la base las quita igual.
const MARKS = /[\u0300-\u036f]/g;
// Lo que da un slug: una letra o un dígito latinos, ya sin acento.
const SLUG_CHARACTER = /[a-z0-9]/;

export type CatalogNameResult =
  | { ok: true; /** En NFC y sin espacios en los extremos: lo que se guarda. */ name: string }
  | { ok: false; reason: "empty" | "too_long" | "invalid" };

export function parseCatalogName(input: string | null): CatalogNameResult {
  const raw = input ?? "";
  if (raw.length > INPUT_MAX_LENGTH) return { ok: false, reason: "too_long" };
  const name = raw.normalize("NFC").trim();
  if (name === "") return { ok: false, reason: "empty" };
  if ([...name].length > CATALOG_NAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (FORBIDDEN.test(name)) return { ok: false, reason: "invalid" };
  // Y que dé un slug: «¡¡!!» o un nombre sin letras latinas dejarían la dirección vacía.
  if (!SLUG_CHARACTER.test(name.normalize("NFD").replace(MARKS, "").toLowerCase())) return { ok: false, reason: "invalid" };
  return { ok: true, name };
}
