import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// El dominio de acceso exige el 100 % de cobertura (TRD §12.2). Un comentario de exclusión
// lo cumpliría sin probar nada: aquí se prohíben. Si una rama no se puede cubrir, sobra, y
// se quita; no se esconde.

const root = join(process.cwd(), "src", "domain");
const IGNORE = /(?:v8|istanbul|c8|node:coverage)\s+ignore/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("cobertura del dominio", () => {
  it("ningún archivo del dominio excluye código de la cobertura con un comentario", () => {
    const offenders = sourceFiles(root).filter((file) => IGNORE.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("la búsqueda sí reconoce un comentario de exclusión", () => {
    expect(IGNORE.test("/* v8 ignore next */")).toBe(true);
    expect(IGNORE.test("// istanbul ignore else")).toBe(true);
    expect(IGNORE.test("// un comentario cualquiera")).toBe(false);
  });
});
