import { describe, expect, it } from "vitest";

import { terms } from "@/messages/es/terms";
import { template } from "@/messages/format";

import { said } from "./view";

describe("said: los avisos del catálogo, con sus términos", () => {
  it("una cadena sale igual, y una plantilla con un término lo pinta", () => {
    expect(said("Hola")).toBe("Hola");
    expect(said(template("Como {maestro}"))).toBe(`Como ${terms.maestro}`);
  });

  it("un aviso que pide un dato no compila", () => {
    // @ts-expect-error: «{count}» es un dato, y `said` no los recibe.
    expect(() => said(template("Faltan {count}"))).toThrow();
  });
});
