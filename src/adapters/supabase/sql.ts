import "server-only";

// Toda consulta se escribe con esta etiqueta, y sus valores viajan siempre como
// parámetros. No es un gusto de estilo: dentro de una transacción «como usuario» un
// `reset role` devolvería el salto de la seguridad por fila (TRD §8.10), así que un texto
// de la persona pegado al SQL sería una fuga completa. Las funciones del adaptador no
// aceptan nada que no haya salido de aquí.

export type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Uint8Array
  | readonly SqlValue[]
  | { readonly [key: string]: unknown };

export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

// Lo que produjo la etiqueta. Un objeto con la misma forma, armado a mano, no está aquí.
const produced = new WeakSet<object>();

interface Fragment {
  readonly strings: readonly string[];
  readonly values: readonly (SqlValue | SqlQuery)[];
}
const fragments = new WeakMap<object, Fragment>();

export function isSqlQuery(value: unknown): value is SqlQuery {
  return typeof value === "object" && value !== null && produced.has(value);
}

// Lo que tiene la plantilla que arma el propio lenguaje. No es una garantía: en
// JavaScript se puede imitar del todo. Para las imitaciones descuidadas basta, y llamar a
// `sql(...)` como función, que es la única forma de pasarle una, lo prohíbe el lint.
function isTemplate(strings: unknown): strings is TemplateStringsArray {
  if (!Array.isArray(strings) || !Object.isFrozen(strings)) return false;
  const raw = (strings as { raw?: unknown }).raw;
  return (
    Array.isArray(raw) &&
    Object.isFrozen(raw) &&
    raw.length === strings.length &&
    strings.every((part) => typeof part === "string")
  );
}

function render(fragment: Fragment, values: unknown[]): string {
  let text = fragment.strings[0] ?? "";
  fragment.values.forEach((value, index) => {
    if (value === undefined) {
      throw new TypeError("sql: un valor es undefined. Usa null si quieres mandar un nulo.");
    }
    const nested = isSqlQuery(value) ? fragments.get(value) : undefined;
    if (nested) {
      text += render(nested, values);
    } else {
      // `pg` no sabe mandar un bigint: va como texto y la base lo convierte.
      values.push(typeof value === "bigint" ? value.toString() : value);
      text += `$${values.length}`;
    }
    text += fragment.strings[index + 1] ?? "";
  });
  return text;
}

export function sql(strings: TemplateStringsArray, ...values: (SqlValue | SqlQuery)[]): SqlQuery {
  if (!isTemplate(strings)) {
    throw new TypeError("sql solo se usa como etiqueta: sql`select ...`, nunca con texto armado.");
  }
  const fragment: Fragment = { strings, values };
  const rendered: unknown[] = [];
  const query: SqlQuery = Object.freeze({
    text: render(fragment, rendered),
    values: Object.freeze(rendered),
  });
  produced.add(query);
  fragments.set(query, fragment);
  return query;
}
