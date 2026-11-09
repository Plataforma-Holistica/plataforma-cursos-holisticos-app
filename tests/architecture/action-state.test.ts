import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// Una acción de `useActionState` no va atada con `bind` (medido el 2026-11-08 en el camino del equipo, con la conciliación de
// PA-79). Sin JavaScript, al volver de la acción, React compara la acción de la pantalla con la que se envió, y con argumentos
// atados espera la promesa de esos argumentos (`isSignatureEqual`); `bind` en cada pintada arma otra que no ha terminado, así que
// la página nunca termina de pintarse. Lo que la acción necesita de la pantalla viaja en un campo oculto, y se revisa como
// cualquier otro campo del formulario.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sources = sourceFiles(src)
  .filter((path) => path.endsWith(".tsx") || path.endsWith(".ts"))
  .map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8").replaceAll("\r", "")).replace(/\s+/g, " ") }));

describe("las acciones de useActionState", () => {
  it("hay pantallas que revisar", () => {
    expect(sources.filter((source) => source.text.includes("useActionState(")).length).toBeGreaterThan(10);
  });

  it("ninguna va atada con bind", () => {
    const bound = sources.filter((source) => /useActionState\(\s*[\w.]+\.bind\(/.test(source.text)).map((source) => source.file);
    expect(bound).toEqual([]);
  });

  it("ninguna recibe una acción atada en otra línea", () => {
    // Una acción atada antes y pasada por nombre también cuelga la página: en las pantallas no se ata ninguna acción.
    const bound = sources.filter((source) => /\b\w+Action\.bind\(/.test(source.text)).map((source) => source.file);
    expect(bound).toEqual([]);
  });

  it("ni las pantallas que usan useActionState ni los archivos de acciones atan nada", () => {
    // Una acción con otro nombre tampoco: en esos archivos no hay ningún `.bind(`.
    const bound = sources
      .filter((source) => source.text.includes("useActionState") || /^\s*["']use server["']/.test(source.text))
      .filter((source) => /\.bind\(/.test(source.text))
      .map((source) => source.file);
    expect(bound).toEqual([]);
  });
});
