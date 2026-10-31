// La CLABE: 18 dígitos, y el último es de control (Banxico, Circular 12/2018, anexo de la estructura). No se revisa contra una
// lista de bancos: esa lista cambia, y una cuenta buena de un banco nuevo no se puede rechazar.

export const CLABE_LENGTH = 18;

export type ClabeResult = { ok: true; clabe: string; last4: string } | { ok: false; reason: "empty" | "length" | "check_digit" };

const WEIGHTS = [3, 7, 1];

/**
 * El dígito de control de los primeros 17 dígitos: cada uno por su peso (3, 7 y 1, en ciclo), de cada producto su unidad, y lo
 * que le falta a la suma para llegar a la siguiente decena.
 */
export function clabeCheckDigit(first17: string): number {
  let sum = 0;
  for (let position = 0; position < first17.length; position += 1) {
    sum += (Number(first17[position]) * (WEIGHTS[position % 3] ?? 1)) % 10;
  }
  return (10 - (sum % 10)) % 10;
}

/** Una CLABE, sin los espacios y guiones con que se copia. */
export function parseClabe(input: string): ClabeResult {
  const clabe = input.replace(/[\s-]/g, "");
  if (clabe === "") return { ok: false, reason: "empty" };
  if (!/^[0-9]{18}$/.test(clabe)) return { ok: false, reason: "length" };
  // Dieciocho ceros cuadran con su dígito de control, y no son de nadie.
  if (clabeCheckDigit(clabe.slice(0, 17)) !== Number(clabe[17]) || /^0+$/.test(clabe)) return { ok: false, reason: "check_digit" };
  return { ok: true, clabe, last4: clabe.slice(-4) };
}
