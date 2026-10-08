import { terms } from "./es/terms";

// Cómo se muestra un texto del catálogo. Un texto puede traer marcadores entre llaves, de
// dos clases:
//
//   - de término, con el nombre de una clave del bloque de términos: {el_maestro}. Los
//     sustituye `t` sola.
//   - de dato, en camelCase y en inglés: {count}. Quien muestra el texto pasa su valor.
//
// Los tipos lo hacen cumplir: un dato que falta o que sobra no compila. Un marcador mal
// escrito no coincide con ningún término, pasa por dato, y tampoco compila sin su valor.

export type TermKey = keyof typeof terms;
export type TermBlock = Readonly<Record<TermKey, string>>;

type Markers<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Markers<Rest>
  : never;

type DataMarkers<Text extends string> = Exclude<Markers<Text>, TermKey>;

type Values<Text extends string> = [DataMarkers<Text>] extends [never]
  ? []
  : [values: Readonly<Record<DataMarkers<Text>, string | number>>];

export type Translator = <Text extends string>(text: Text, ...values: Values<Text>) => string;

const MARKER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Un `t` que usa otro bloque de términos. Es lo que prueba que el cambio vive en un lugar. */
export function createTranslator(block: TermBlock): Translator {
  return (text: string, ...rest: readonly unknown[]) => {
    const values = (rest[0] ?? {}) as Readonly<Record<string, string | number>>;
    return text.replace(MARKER, (_match, name: string) => {
      if (Object.hasOwn(values, name)) return String(values[name]);
      if (Object.hasOwn(block, name)) return block[name as TermKey];
      // Antes un error que unas llaves a la vista de la gente.
      throw new Error(`Al texto le falta el valor de {${name}}.`);
    });
  };
}

/** Muestra un texto del catálogo: sustituye sus términos y sus datos. */
export const t: Translator = createTranslator(terms);

const pluralRules = new Intl.PluralRules("es-MX");

/** Elige la forma de un texto según una cantidad: «1 dato», «2 datos». */
export function plural<One extends string, Other extends string>(
  count: number,
  forms: { readonly one: One; readonly other: Other },
): One | Other {
  return pluralRules.select(count) === "one" ? forms.one : forms.other;
}
