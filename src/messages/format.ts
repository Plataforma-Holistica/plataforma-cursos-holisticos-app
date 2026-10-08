import { terms } from "./es/terms";

// Cómo se muestra un texto del catálogo. Un texto puede traer marcadores entre llaves, de
// dos clases:
//
//   - de término, con el nombre de una clave del bloque de términos: {el_maestro}. Los
//     sustituye `t` sola.
//   - de dato, en camelCase y en inglés: {count}. Quien muestra el texto pasa su valor.
//
// Un texto con marcadores no es un texto: es una plantilla, un objeto que ni TypeScript ni
// React dejan poner en una pantalla. Lo único que lo convierte en texto es `t()`. Así un
// texto con sus llaves no puede llegar a la vista de nadie por olvido, que era lo que
// pasaba cuando una plantilla era una cadena como cualquier otra.
//
// Los tipos hacen cumplir lo demás: un dato que falta o que sobra no compila. Un marcador
// mal escrito no coincide con ningún término, pasa por dato, y tampoco compila sin su
// valor.

export type TermKey = keyof typeof terms;
export type TermBlock = Readonly<Record<TermKey, string>>;

/** Un texto con marcadores. Solo `t()` lo convierte en algo que se puede mostrar. */
export interface Template<Text extends string = string> {
  readonly template: Text;
}

type Markers<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Markers<Rest>
  : never;

type DataMarkers<Text extends string> = Exclude<Markers<Text>, TermKey>;

type Values<Text extends string> = [DataMarkers<Text>] extends [never]
  ? []
  : [values: Readonly<Record<DataMarkers<Text>, string | number>>];

export type Translator = <Text extends string>(
  text: Template<Text>,
  ...values: Values<Text>
) => string;

const MARKER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Lo que queda de un texto bien escrito al quitarle sus marcadores no trae llaves. */
function hasLooseBraces(text: string): boolean {
  return /[{}]/.test(text.replace(MARKER, ""));
}

/** Una plantilla suelta. El catálogo las arma con `defineMessages`. */
export function template<const Text extends string>(text: Text): Template<Text> {
  if (hasLooseBraces(text)) {
    throw new Error(`Hay un marcador mal escrito en «${text}»: van así, {nombre}, sin espacios.`);
  }
  return Object.freeze({ template: text });
}

interface MessageTree {
  readonly [key: string]: string | MessageTree;
}

/** El bloque tal como se usa: cada texto con marcadores, convertido en plantilla. */
type Defined<Tree> = {
  readonly [Key in keyof Tree]: Tree[Key] extends string
    ? [Markers<Tree[Key]>] extends [never]
      ? Tree[Key]
      : Template<Tree[Key]>
    : Defined<Tree[Key]>;
};

function define(tree: MessageTree, path: string): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tree)) {
    const here = path ? `${path}.${key}` : key;
    if (typeof value !== "string") out[key] = define(value, here);
    else if (!/[{}]/.test(value)) out[key] = value;
    else {
      try {
        out[key] = template(value);
      } catch (error) {
        throw new Error(`${here}: ${(error as Error).message}`);
      }
    }
  }
  return Object.freeze(out);
}

/**
 * Define un bloque del catálogo. Un texto sin marcadores se queda como texto y se muestra
 * tal cual; uno con marcadores se vuelve plantilla y solo se muestra con `t()`. Un
 * marcador mal escrito no deja cargar el bloque.
 */
export function defineMessages<const Tree extends MessageTree>(tree: Tree): Defined<Tree> {
  return define(tree, "") as Defined<Tree>;
}

/** Un `t` que usa otro bloque de términos. Es lo que prueba que el cambio vive en un lugar. */
export function createTranslator(block: TermBlock): Translator {
  return (text: Template, ...rest: readonly unknown[]) => {
    // Lo único que `t` sabe mostrar es una plantilla. Los tipos ya lo impiden; esto es
    // para quien los haya saltado.
    if (typeof text !== "object" || text === null || typeof text.template !== "string") {
      throw new TypeError("t solo muestra plantillas del catálogo, no texto suelto.");
    }
    const values = (rest[0] ?? {}) as Readonly<Record<string, string | number>>;
    return text.template.replace(MARKER, (_match, name: string) => {
      if (Object.hasOwn(values, name)) return String(values[name]);
      if (Object.hasOwn(block, name)) return block[name as TermKey];
      // Antes un error que unas llaves a la vista de la gente.
      throw new Error(`Al texto le falta el valor de {${name}}.`);
    });
  };
}

/** Muestra una plantilla del catálogo: sustituye sus términos y sus datos. */
export const t: Translator = createTranslator(terms);

const pluralRules = new Intl.PluralRules("es-MX");

/** Elige la forma de un texto según una cantidad: «1 dato», «2 datos». */
export function plural<One, Other>(
  count: number,
  forms: { readonly one: One; readonly other: Other },
): One | Other {
  return pluralRules.select(count) === "one" ? forms.one : forms.other;
}
