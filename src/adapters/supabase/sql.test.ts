import { describe, expect, it } from "vitest";

import { isSqlQuery, sql } from "./sql";

describe("etiqueta sql", () => {
  it("manda cada valor como parámetro, numerado en orden", () => {
    const query = sql`select * from t where a = ${1} and b = ${"x"}`;
    expect(query.text).toBe("select * from t where a = $1 and b = $2");
    expect(query.values).toEqual([1, "x"]);
  });

  it("una consulta sin valores no lleva parámetros", () => {
    const query = sql`select 1`;
    expect(query.text).toBe("select 1");
    expect(query.values).toEqual([]);
  });

  it("un texto con apariencia de SQL viaja como valor, no como SQL", () => {
    const hostile = "'; reset role; --";
    const query = sql`select ${hostile}`;
    expect(query.text).toBe("select $1");
    expect(query.values).toEqual([hostile]);
  });

  it("un fragmento se incrusta y sus parámetros se renumeran", () => {
    const filter = sql`b = ${2}`;
    const query = sql`select * from t where a = ${1} and ${filter} and c = ${3}`;
    expect(query.text).toBe("select * from t where a = $1 and b = $2 and c = $3");
    expect(query.values).toEqual([1, 2, 3]);
  });

  it("un entero grande viaja como texto, sin perder dígitos", () => {
    expect(sql`select ${9007199254740993n}`.values).toEqual(["9007199254740993"]);
  });

  it("null es un valor; undefined es un error", () => {
    expect(sql`select ${null}`.values).toEqual([null]);
    expect(() => sql`select ${undefined as unknown as null}`).toThrow(/undefined/);
  });

  it("solo funciona como etiqueta: no acepta texto armado a mano", () => {
    const forged = ["select " + "1"] as unknown as TemplateStringsArray;
    expect(() => sql(forged)).toThrow(/etiqueta/);
  });

  it("isSqlQuery reconoce solo lo que produjo la etiqueta", () => {
    expect(isSqlQuery(sql`select 1`)).toBe(true);
    expect(isSqlQuery({ text: "select 1", values: [] })).toBe(false);
    expect(isSqlQuery("select 1")).toBe(false);
  });
});
