import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { terms } from "./es/terms";
import { createTranslator, defineMessages, plural, t, template } from "./format";

describe("t: sustituye los marcadores de un texto", () => {
  it("un marcador de término sale del bloque de términos", () => {
    expect(t(template("Sobre {el_maestro}"))).toBe(`Sobre ${terms.el_maestro}`);
    expect(t(template("Cursos de {maestros}"))).toBe(`Cursos de ${terms.maestros}`);
  });

  it("un marcador de dato sale de los valores que se le pasan", () => {
    expect(t(template("Hay {count} datos por corregir"), { count: 2 })).toBe(
      "Hay 2 datos por corregir",
    );
  });

  it("términos y datos conviven en el mismo texto", () => {
    expect(t(template("{page} · {Plataforma}"), { page: "Entrar" })).toBe(
      `Entrar · ${terms.Plataforma}`,
    );
  });

  it("un marcador repetido se sustituye todas las veces", () => {
    expect(t(template("{name}, {name}"), { name: "Ana" })).toBe("Ana, Ana");
  });

  it("un dato que trae llaves no se vuelve a sustituir", () => {
    expect(t(template("Hola, {name}"), { name: "{Plataforma}" })).toBe("Hola, {Plataforma}");
  });

  it("lanza si a un texto le falta un valor, en vez de enseñar las llaves", () => {
    const loose = template("Hola, {name}" as string);
    expect(() => t(loose, {})).toThrow(/\{name\}/);
  });

  // Una plantilla cuyo texto ya no se conoce al compilar (pasó por una función que la
  // recibe como «una plantilla cualquiera») no puede decir qué datos pide. Entonces los
  // valores son obligatorios: sin ellos compilaba y lanzaba al pintar.
  it("una plantilla de texto desconocido exige que le pasen valores", () => {
    const loose = template("Hola, {name}" as string);
    // @ts-expect-error no se sabe qué datos pide: hay que pasarle valores
    expect(() => t(loose)).toThrow();
    expect(t(loose, { name: "Ana" })).toBe("Hola, Ana");
  });

  it("los tipos exigen cada dato y rechazan los que sobran", () => {
    // @ts-expect-error falta el valor de {count}
    expect(() => t(template("Hay {count} datos"))).toThrow();
    // @ts-expect-error {total} no es un marcador de este texto
    expect(t(template("Hay {count} datos"), { count: 1, total: 2 })).toBe("Hay 1 datos");
    // @ts-expect-error un texto sin datos no recibe valores
    expect(t(template("Sobre {el_maestro}"), { el_maestro: "x" })).toBe("Sobre x");
  });
});

// La falla que esto cierra: un texto con marcadores pintado tal cual enseñaba las llaves a
// la gente, y no fallaba ningún tipo, lint ni prueba. Ahora un texto con marcadores no es
// un texto: es una plantilla, y lo único que la convierte en texto es `t()`.
describe("una plantilla no se puede mostrar sin pasar por t", () => {
  it("no es un texto ni nada que React sepa pintar", () => {
    const greeting = template("Hola, {name}");
    expect(typeof greeting).toBe("object");

    // @ts-expect-error una plantilla no es un texto
    const asText: string = greeting;
    // @ts-expect-error una plantilla no se puede poner en una pantalla
    const asNode: ReactNode = greeting;
    expect([asText, asNode]).toHaveLength(2);
  });

  it("t solo recibe plantillas: un texto suelto no compila", () => {
    // @ts-expect-error t no recibe texto suelto
    expect(() => t("Hola")).toThrow();
  });

  // La salida fácil ante el error de tipos era armar la plantilla a mano o leerle el
  // texto. Ninguna de las dos compila fuera de este módulo.
  it("una plantilla no se arma a mano: solo la hacen template y defineMessages", () => {
    // @ts-expect-error un objeto con la misma forma no es una plantilla
    expect(t({ template: "Hola, {Plataforma}" })).toContain("Hola");
  });

  it("no se puede cambiar después de creada", () => {
    expect(Object.isFrozen(template("Hola, {name}"))).toBe(true);
  });

  it.each(["Hola, {}", "Hola, {a b}", "Hola, {name", "Hola, name}", "Hola, {{name}}", "{1dato}"])(
    "rechaza un marcador mal escrito al definirla: %j",
    (text) => {
      expect(() => template(text)).toThrow(/marcador/);
    },
  );
});

describe("defineMessages: un bloque del catálogo", () => {
  const block = defineMessages({
    plain: "Saltar al contenido",
    greeting: "Hola, {name}",
    nested: { about: "Sobre {el_maestro}", ok: "Listo." },
  });

  it("un texto sin marcadores se queda como texto: se muestra tal cual", () => {
    const shown: string = block.plain;
    expect(shown).toBe("Saltar al contenido");
    expect(block.nested.ok).toBe("Listo.");
  });

  it("un texto con marcadores se vuelve plantilla, a cualquier profundidad", () => {
    expect(t(block.greeting, { name: "Ana" })).toBe("Hola, Ana");
    expect(t(block.nested.about)).toBe(`Sobre ${terms.el_maestro}`);
    // @ts-expect-error ya no es un texto: no se puede mostrar sin t
    const raw: string = block.greeting;
    expect(typeof raw).toBe("object");
  });

  it("un marcador mal escrito no deja cargar el bloque", () => {
    expect(() => defineMessages({ bad: "Hola, {a b}" })).toThrow(/bad.*marcador|marcador.*bad/);
  });

  it("el bloque no se puede cambiar después", () => {
    expect(Object.isFrozen(block)).toBe(true);
    expect(Object.isFrozen(block.nested)).toBe(true);
  });
});

describe("plural: una forma puede no llevar el número", () => {
  const forms = defineMessages({
    one: "Falta un dato",
    other: "Faltan {count} datos",
  });

  it.each([
    [1, "Falta un dato"],
    [3, "Faltan 3 datos"],
  ])("%d", (count, expected) => {
    expect(t(plural(count, forms), { count })).toBe(expected);
  });
});

describe("plural: elige la forma según la cantidad", () => {
  const forms = defineMessages({
    one: "Hay {count} dato por corregir",
    other: "Hay {count} datos por corregir",
  });

  it.each([
    [1, "Hay 1 dato por corregir"],
    [0, "Hay 0 datos por corregir"],
    [2, "Hay 2 datos por corregir"],
    [21, "Hay 21 datos por corregir"],
  ])("%d", (count, expected) => {
    expect(t(plural(count, forms), { count })).toBe(expected);
  });
});

describe("createTranslator: el mismo texto con otro bloque de términos", () => {
  it("cambia la palabra sin tocar el texto", () => {
    const other = createTranslator({ ...terms, el_maestro: "la terapeuta" });
    expect(other(template("Sobre {el_maestro}"))).toBe("Sobre la terapeuta");
  });
});
