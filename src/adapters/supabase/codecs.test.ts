import { describe, expect, it } from "vitest";

import { dbBigint } from "./codecs";

describe("enteros grandes de la base", () => {
  it("llegan como texto y salen como bigint, sin perder dígitos", () => {
    expect(dbBigint.parse("9007199254740993")).toBe(9007199254740993n);
    expect(dbBigint.parse("-349")).toBe(-349n);
    expect(dbBigint.parse("0")).toBe(0n);
  });

  it.each(["1.5", "", " 1", "1e3", "abc", "0x10"])("rechaza el texto «%s»", (value) => {
    expect(dbBigint.safeParse(value).success).toBe(false);
  });

  it("rechaza un número: ya habría perdido precisión por el camino", () => {
    expect(dbBigint.safeParse(349).success).toBe(false);
  });
});
