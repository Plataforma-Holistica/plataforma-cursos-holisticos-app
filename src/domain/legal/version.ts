// Lo que se publica como versión nueva de un texto legal (RF-713, PA-89; T-110): el único criterio
// de «título, texto y día válidos» antes de la base. Lo usan el servicio, antes de preguntarle a la
// base, y la pantalla, antes de llamar al servicio: así un campo que no pasa se dice en su lugar y lo
// escrito no se pierde.
//
// La base revisa lo mismo y manda (`private.publish_legal_document()`): un título de 1 a 200
// caracteres sin caracteres de control, un texto que no está en blanco, de hasta 200 000 caracteres,
// con saltos de línea y tabuladores y sin otros caracteres de control, y un día que no es pasado ni
// está a más de 366 días.

/** El de la base: `char_length(title) between 1 and 200`, que cuenta caracteres. */
export const LEGAL_TITLE_MAX_LENGTH = 200;
/** El de la base: `char_length(body) <= 200000` (decisión mía sin confirmar del 2026-10-28). */
export const LEGAL_BODY_MAX_LENGTH = 200_000;
/** A lo más a cuántos días se programa una versión: el de la base. */
export const LEGAL_DAYS_AHEAD_MAX = 366;

// Más largo que esto se da por largo sin normalizarlo: sería trabajo por nada.
const TITLE_INPUT_MAX = 2_000;
const BODY_INPUT_MAX = 4 * LEGAL_BODY_MAX_LENGTH;

const TITLE_FORBIDDEN = /\p{Cc}/u;
// Los de la base: todo control salvo el salto de línea y el tabulador (el retorno de carro ya se
// cambió por un salto).
const BODY_FORBIDDEN = /[\u0001-\u0008\u000b-\u001f\u007f]/;
const BODY_BLANK = /^[ \n\t]*$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export type LegalTitleResult = { ok: true; title: string } | { ok: false; reason: "empty" | "too_long" | "invalid" };
export type LegalBodyResult = { ok: true; body: string } | { ok: false; reason: "empty" | "too_long" | "invalid" };
export type LegalDayResult = { ok: true; day: string } | { ok: false; reason: "empty" | "invalid" | "past" | "too_far" };

/** El título, en NFC y sin espacios en los extremos: lo que se guarda. */
export function parseLegalTitle(input: string | null): LegalTitleResult {
  const raw = input ?? "";
  if (raw.length > TITLE_INPUT_MAX) return { ok: false, reason: "too_long" };
  const title = raw.normalize("NFC").trim();
  if (title === "") return { ok: false, reason: "empty" };
  if ([...title].length > LEGAL_TITLE_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (TITLE_FORBIDDEN.test(title)) return { ok: false, reason: "invalid" };
  return { ok: true, title };
}

/**
 * El texto, con los finales de renglón de un formulario (`\r\n`, o un `\r` suelto) cambiados por
 * saltos de línea. Nada más se toca: ni espacios, ni la normalización, porque su huella es la del
 * texto tal cual se publica.
 */
export function parseLegalBody(input: string | null): LegalBodyResult {
  const raw = input ?? "";
  if (raw.length > BODY_INPUT_MAX) return { ok: false, reason: "too_long" };
  const body = raw.replace(/\r\n?/g, "\n");
  if (BODY_BLANK.test(body)) return { ok: false, reason: "empty" };
  if ([...body].length > LEGAL_BODY_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (BODY_FORBIDDEN.test(body)) return { ok: false, reason: "invalid" };
  return { ok: true, body };
}

/** Un día del calendario (`AAAA-MM-DD`) que existe, o nulo. */
function calendarDay(input: string): number | null {
  const match = DAY.exec(input);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, day);
  const date = new Date(at);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return at / 86_400_000;
}

/**
 * El día de vigencia contra `today`, el día de hoy en la zona del periodo tal como lo dio la base
 * (`AAAA-MM-DD`). Hoy rige al publicar; un día pasado no se publica.
 */
export function parseLegalDay(input: string | null, today: string): LegalDayResult {
  const raw = (input ?? "").trim();
  if (raw === "") return { ok: false, reason: "empty" };
  const day = calendarDay(raw);
  const base = calendarDay(today);
  if (day === null || base === null) return { ok: false, reason: "invalid" };
  if (day < base) return { ok: false, reason: "past" };
  if (day - base > LEGAL_DAYS_AHEAD_MAX) return { ok: false, reason: "too_far" };
  return { ok: true, day: raw };
}
