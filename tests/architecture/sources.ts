import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Cómo leen el código las pruebas de arquitectura: qué archivos hay y qué termina cargando
// cada uno. El lint solo mira las importaciones directas; aquí se sigue la cadena completa.

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const src = join(root, "src");
export const posix = (path: string) => relative(root, path).replaceAll("\\", "/");

/** Los archivos de código de una carpeta, sin sus pruebas. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Toda forma de traer otro módulo: `import … from`, `export … from`, `import "x"`,
// `import("x")` y `require("x")`, con comillas o con comillas invertidas. También los que
// solo traen tipos: si un día dejan de serlo, la cadena ya estaba vigilada.
export const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]([^"'`]+)["'`]/g;

/** Los nombres que `SPECIFIER` saca de un texto. */
export const specifiersIn = (text: string) => [...text.matchAll(SPECIFIER)].map((match) => match[1]);

// Una sentencia que solo trae tipos: `import type … from` y `export type … from`. Al
// compilar desaparece entera. Una que mezcla (`import { type A, b }`) no entra aquí.
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;'"`]*?\bfrom\s*["'`][^"'`]+["'`]\s*;?/g;

/** El texto sin las sentencias que solo traen tipos. */
export const withoutTypeImports = (text: string) => text.replace(TYPE_ONLY, "");

export function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(src, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  // Una hoja de estilos no es código: no trae nada más.
  if (/\.css$/.test(specifier)) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  const found = candidates.find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate));
  if (!found) throw new Error(`No se pudo seguir la importación "${specifier}" de ${posix(from)}.`);
  return found;
}

export interface ReachOptions {
  /**
   * Lo que viaja de verdad: no sigue las sentencias que solo traen tipos. Sin esto se
   * siguen todas, que es lo prudente cuando lo que se cuida es a qué se puede llegar.
   */
  runtimeOnly?: boolean;
  /** Un archivo en el que la cadena se corta: se anota, pero no se siguen sus importaciones. */
  stopAt?: (text: string) => boolean;
}

/** Todo lo que un archivo termina cargando: sus archivos de `src/` y sus paquetes. */
export function reachableFrom(entry: string, options: ReachOptions = {}): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    if (file !== entry && options.stopAt?.(text)) continue;
    for (const match of (options.runtimeOnly ? withoutTypeImports(text) : text).matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      const local = resolveLocal(file, specifier);
      if (local) pending.push(local);
      else packages.add(specifier);
    }
  }
  return { files, packages };
}
