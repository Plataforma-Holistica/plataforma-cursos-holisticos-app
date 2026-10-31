// El RFC: el patrón del tipo `t_RFC` del SAT (`tdCFDI.xsd`), con una fecha que exista, que el patrón no revisa. La homoclave no se
// calcula: el SAT no publica un algoritmo oficial, y rechazar un RFC bueno detendría un pago.

export type PayeeKind = "person" | "company";

export type RfcResult = { ok: true; rfc: string; kind: PayeeKind } | { ok: false; reason: "empty" | "form" | "date" | "generic" };

const MONTH = "(0[1-9]|1[012])";
const DAY = "(0[1-9]|[12][0-9]|3[01])";
const PERSON = new RegExp(`^[A-Z&Ñ]{4}([0-9]{2})${MONTH}${DAY}[A-Z0-9]{2}[0-9A]$`);
const COMPANY = new RegExp(`^[A-Z&Ñ]{3}([0-9]{2})${MONTH}${DAY}[A-Z0-9]{2}[0-9A]$`);

// Los genéricos del SAT, al público en general y a extranjeros: no son de una persona, y con ellos no se le factura a nadie.
const GENERIC: ReadonlySet<string> = new Set(["XAXX010101000", "XEXX010101000"]);

/** ¿Existe ese día? El año lleva dos dígitos, y entre 2000 y 2099 están todos los 29 de febrero posibles. */
function dateExists(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(2000 + year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Un RFC, en mayúsculas y sin los espacios y guiones con que se copia. */
export function parseRfc(input: string): RfcResult {
  const rfc = input.replace(/[\s-]/g, "").toUpperCase();
  if (rfc === "") return { ok: false, reason: "empty" };
  if (GENERIC.has(rfc)) return { ok: false, reason: "generic" };
  const person = PERSON.exec(rfc);
  const match = person ?? COMPANY.exec(rfc);
  if (match === null) return { ok: false, reason: "form" };
  if (!dateExists(Number(match[1]), Number(match[2]), Number(match[3]))) return { ok: false, reason: "date" };
  return { ok: true, rfc, kind: person === null ? "company" : "person" };
}
