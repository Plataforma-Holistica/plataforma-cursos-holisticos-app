import { describe, expect, it } from "vitest";

import { terms } from "./es/terms";
import { createTranslator, plural, t } from "./format";

describe("t: sustituye los marcadores de un texto", () => {
  it("un texto sin marcadores sale igual", () => {
    expect(t("Saltar al contenido")).toBe("Saltar al contenido");
  });

  it("un marcador de término sale del bloque de términos", () => {
    expect(t("Sobre {el_maestro}")).toBe(`Sobre ${terms.el_maestro}`);
    expect(t("Cursos de {maestros}")).toBe(`Cursos de ${terms.maestros}`);
  });

  it("un marcador de dato sale de los valores que se le pasan", () => {
    expect(t("Hay {count} datos por corregir", { count: 2 })).toBe("Hay 2 datos por corregir");
  });

  it("términos y datos conviven en el mismo texto", () => {
    expect(t("{page} · {Plataforma}", { page: "Entrar" })).toBe(`Entrar · ${terms.Plataforma}`);
  });

  it("un marcador repetido se sustituye todas las veces", () => {
    expect(t("{name}, {name}", { name: "Ana" })).toBe("Ana, Ana");
  });

  it("lanza si a un texto le falta un valor, en vez de enseñar las llaves", () => {
    const loose: string = "Hola, {name}";
    expect(() => t(loose)).toThrow(/\{name\}/);
  });

  it("los tipos exigen cada dato y rechazan los que sobran", () => {
    // @ts-expect-error falta el valor de {count}
    expect(() => t("Hay {count} datos")).toThrow();
    // @ts-expect-error {total} no es un marcador de este texto
    expect(t("Hay {count} datos", { count: 1, total: 2 })).toBe("Hay 1 datos");
    // @ts-expect-error un texto sin datos no recibe valores
    expect(t("Sobre {el_maestro}", { el_maestro: "x" })).toBe("Sobre x");
  });
});

describe("plural: elige la forma según la cantidad", () => {
  const forms = {
    one: "Hay {count} dato por corregir",
    other: "Hay {count} datos por corregir",
  } as const;

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
    expect(other("Sobre {el_maestro}")).toBe("Sobre la terapeuta");
  });
});
