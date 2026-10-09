import { describe, expect, it } from "vitest";

import { terms } from "./es/terms";
import { createTranslator, template, type TermBlock } from "./format";
import { messages } from "./index";

// La prueba de la tarea T-109 (RNF-15): cambiar «maestro» en un lugar lo cambia en toda
// la interfaz. Recorre el catálogo entero, así que cada texto nuevo queda cubierto solo.

const MARKER = /\{([^{}]*)\}/g;
const DATA_MARKER = /^[a-z][A-Za-z0-9]*$/;
const termKeys = new Set<string>(Object.keys(terms));

const isTemplate = (node: unknown): node is { template: string } =>
  typeof node === "object" &&
  node !== null &&
  Object.keys(node).length === 1 &&
  typeof (node as { template?: unknown }).template === "string";

/**
 * Todos los textos del catálogo, con la ruta de su clave. El bloque de términos, aparte.
 * Un texto con marcadores vive como plantilla: aquí se lee su texto, y `templates` anota
 * cuáles lo son.
 */
const templates = new Set<string>();
function collect(node: unknown, path: string, out: Map<string, string>): Map<string, string> {
  if (typeof node === "string") out.set(path, node);
  else if (isTemplate(node)) {
    out.set(path, node.template);
    templates.add(path);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) collect(value, path ? `${path}.${key}` : key, out);
  }
  return out;
}

const blocks = Object.fromEntries(Object.entries(messages).filter(([name]) => name !== "terms"));
const texts = collect(blocks, "", new Map());

const markersOf = (text: string) => [...text.matchAll(MARKER)].map((match) => match[1] ?? "");

/** Valores de relleno para los marcadores de dato de un texto. */
const fill = (text: string) =>
  Object.fromEntries(markersOf(text).filter((name) => !termKeys.has(name)).map((name) => [name, "0"]));

/** La raíz de la palabra del rol: «maestr» cubre maestro, maestra y maestros. */
function stem(block: TermBlock): string {
  const one = block.maestro.toLowerCase();
  const many = block.maestros.toLowerCase();
  let length = 0;
  while (length < one.length && one[length] === many[length]) length += 1;
  return one.slice(0, Math.max(length - 1, 3));
}

// El bloque como quedaría si Pablo decide «terapeuta» (PQ-14).
const therapist: TermBlock = {
  ...terms,
  maestro: "terapeuta",
  maestros: "terapeutas",
  Maestro: "Terapeuta",
  Maestros: "Terapeutas",
  el_maestro: "el terapeuta",
  El_maestro: "El terapeuta",
  los_maestros: "los terapeutas",
  Los_maestros: "Los terapeutas",
  del_maestro: "del terapeuta",
  al_maestro: "al terapeuta",
  un_maestro: "un terapeuta",
};

const roleKeys = Object.keys(terms).filter((key) => /maestro/i.test(key));

describe("catálogo de textos", () => {
  it("tiene textos que revisar", () => {
    expect(texts.size).toBeGreaterThan(5);
  });

  it("cambiar la palabra del rol en el bloque de términos la cambia en todos los textos", () => {
    const withTherapist = createTranslator(therapist) as (
      text: { template: string },
      values: Record<string, string>,
    ) => string;
    const loose = (text: string, values: Record<string, string>) =>
      withTherapist(template(text), values);
    const old = new RegExp(stem(terms), "i");

    // Los dos ejemplos del diseño (03, sección 8.5) y todo lo que haya en el catálogo.
    const citing = new Map([
      ["ejemplo.about", "Sobre {el_maestro}"],
      ["ejemplo.courses", "Cursos de {maestros}"],
      ...[...texts].filter(([, text]) => markersOf(text).some((name) => roleKeys.includes(name))),
    ]);

    for (const [key, text] of citing) {
      const shown = loose(text, fill(text));
      expect(shown, key).toMatch(/terapeuta/i);
      expect(shown, key).not.toMatch(old);
    }
  });

  it("ningún texto escribe a mano la palabra del rol ni el nombre de la Plataforma", () => {
    const role = new RegExp(stem(terms), "i");
    for (const [key, text] of texts) {
      expect(text, `${key} debe citar el término con un marcador`).not.toMatch(role);
      expect(text, `${key} debe citar {Plataforma}`).not.toContain(terms.Plataforma);
    }
  });

  it("el bloque de términos trae la palabra del rol en todas sus formas", () => {
    const role = new RegExp(stem(terms), "i");
    expect(roleKeys.length).toBeGreaterThanOrEqual(8);
    for (const key of roleKeys) expect(terms[key as keyof typeof terms], key).toMatch(role);
    // El otro bloque cambió cada forma: si se agrega una y se olvida ahí, esto lo dice.
    for (const key of roleKeys) expect(therapist[key as keyof typeof terms], key).toMatch(/terapeuta/i);
  });

  it("todo marcador es un término que existe o un dato con nombre válido", () => {
    for (const [key, text] of texts) {
      for (const name of markersOf(text)) {
        expect(termKeys.has(name) || DATA_MARKER.test(name), `${key}: {${name}}`).toBe(true);
      }
      expect(text.replace(MARKER, ""), `${key} tiene una llave suelta`).not.toMatch(/[{}]/);
    }
  });

  it("todos los textos se pueden mostrar con sus datos", () => {
    const translate = createTranslator(terms) as (
      text: { template: string },
      values: Record<string, string>,
    ) => string;
    for (const [key, text] of texts) {
      const shown = templates.has(key) ? translate(template(text), fill(text)) : text;
      expect(shown, key).not.toMatch(/[{}]/);
    }
  });

  // Lo que impide que un texto con marcadores se pinte tal cual, con las llaves a la
  // vista: en el catálogo no existe como texto. Solo `t()` lo convierte en uno.
  it("un texto con marcadores es una plantilla, y uno sin marcadores es un texto", () => {
    expect(templates.size).toBeGreaterThan(0);
    for (const [key, text] of texts) {
      expect(templates.has(key), key).toBe(markersOf(text).length > 0);
    }
  });

  it("las claves van en inglés y sin acentos, como el resto de los identificadores", () => {
    for (const key of texts.keys()) expect(key).toMatch(/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/);
  });

  it("los textos cierran con su puntuación y no gritan", () => {
    for (const [key, text] of texts) {
      expect(text, `${key} no lleva admiraciones`).not.toMatch(/[¡!]/);
      expect(text, `${key} no lleva raya`).not.toContain("—");
      expect(text.trim(), `${key} no lleva espacios de sobra`).toBe(text);
    }
  });
});
