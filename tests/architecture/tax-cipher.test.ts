import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, reachableFrom, resolveLocal, sourceFiles, specifiersIn, src } from "./sources";

// El cifrado de los datos fiscales (RF-510; 05 §10; T-409). Un solo archivo cifra y descifra, y quién lo usa es una lista
// cerrada: cada descifrado es un dato personal que sale, y tiene que quedar en la auditoría antes (T-409, segunda y tercera
// solicitud). Lo exige el código, no la buena voluntad.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src)
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file).sort();

const CIPHER = "src/services/teachers/tax-cipher.ts";

/** Quién usa el cifrado. Una entrada nueva aquí es decidir que ese código puede ver un dato fiscal. */
const USERS: readonly string[] = [];

describe("los datos fiscales se cifran en un solo lugar", () => {
  it("AES-GCM se usa solo en el archivo del cifrado", () => {
    expect(naming(/\bcreate(?:De)?[Cc]ipheriv\b/)).toEqual([CIPHER]);
    expect(naming(/aes-256-gcm/i)).toEqual([CIPHER]);
    expect(naming(/AES-GCM|crypto\.subtle/)).toEqual([]);
  });

  it("las llaves se nombran solo en la configuración y en el cifrado", () => {
    expect(naming(/\bPII_ENCRYPTION_(?:KEYS|ACTIVE_VERSION)\b/)).toEqual(["src/config/env.ts", CIPHER]);
  });

  it("quien usa el cifrado es una lista cerrada: se resuelven las importaciones, se escriban como se escriban", () => {
    const importers = sourceFiles(src)
      .filter((path) => !/\.test\.tsx?$/.test(path))
      .filter((path) => specifiersIn(readFileSync(path, "utf8")).some((specifier) => {
        const resolved = specifier === undefined ? null : resolveLocal(path, specifier);
        return resolved !== null && posix(resolved) === CIPHER;
      }))
      .map(posix)
      .sort();
    expect(importers).toEqual([...USERS].sort());
  });

  it("nadie de la lista lo reexporta: sería otra puerta", () => {
    for (const file of USERS) {
      const code = sources.find((source) => source.file === file)?.text ?? "";
      expect(code, file).not.toMatch(/export[^;]*from\s+["'`][^"'`]*tax-cipher/);
    }
  });

  it("el cifrado no se alcanza desde el paso previo", () => {
    const reached = [...reachableFrom(join(src, "proxy.ts")).files].map(posix);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter((file) => file.endsWith("tax-cipher.ts"))).toEqual([]);
  });

  it("es del servidor", () => {
    expect(readFileSync(join(src, "services/teachers/tax-cipher.ts"), "utf8")).toMatch(/^import "server-only";/m);
  });

  it("no escribe en la consola ni encadena el error de Node: podría traer el dato", () => {
    const code = sources.find((source) => source.file === CIPHER)?.text ?? "";
    expect(code).not.toMatch(/\bconsole\./);
    expect(code).not.toMatch(/\bcause\b/);
  });
});
