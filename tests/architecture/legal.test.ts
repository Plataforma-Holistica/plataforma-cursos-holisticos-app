import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// Los textos legales desde administración (PA-89, T-110): por dónde se le pregunta a la base, quién decide y
// qué no sale de ella. Lo que hace cada respuesta lo prueban `src/services/legal/admin*.test.ts` y
// `src/app/admin/_textos/*.test.ts`; aquí, la forma.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";
const core = codeOf("src/services/legal/admin.ts");
const records = codeOf("src/services/legal/admin-records.ts");
const store = codeOf("src/services/legal/admin-store.ts");

const bodyOf = (name: string, code = core) => {
  const start = code.indexOf(`  async function ${name}(`);
  const end = code.indexOf("\n  }\n", start);
  return start === -1 || end === -1 ? "" : code.slice(start, end);
};

describe("los textos legales pasan por las funciones de la base", () => {
  it("hay archivos que revisar", () => {
    for (const code of [core, records, store]) expect(code.length).toBeGreaterThan(0);
  });

  it.each(["publish_legal_document", "legal_documents_admin", "legal_document_admin"])("private.%s() se nombra solo en admin-records.ts, una vez", (name) => {
    const naming = sources.filter((source) => new RegExp(`private\\.${name}\\b`).test(source.text)).map((source) => source.file);
    expect(naming).toEqual(["src/services/legal/admin-records.ts"]);
    expect(records.match(new RegExp(`private\\.${name}\\(`, "g"))).toHaveLength(1);
  });

  it("nada de la aplicación inserta en la tabla de los textos legales: publica la base", () => {
    const writing = sources.filter((source) => /\binsert\s+into\s+public\.legal_documents\b/i.test(source.text));
    expect(writing.map((source) => source.file)).toEqual([]);
  });

  it("el almacén abre sus transacciones como servidor, y solo así", () => {
    expect(store).toMatch(/import \{ asServer \} from "@\/adapters\/supabase\/db";/);
    expect(store).not.toMatch(/\bas(?:User|System)\b/);
    expect(records).not.toMatch(/\bas(?:Server|User|System)\(/);
  });

  it("el servicio no abre transacciones ni lee la base por su cuenta", () => {
    expect(core).not.toMatch(/adapters\/supabase\/db|adapters\/supabase\/auth["']/);
    expect(core).not.toMatch(/\bas(?:User|Server|System)\(/);
  });

  it("la guarda pide configuración, y publicar y dar el código la corren antes que cualquier otra cosa", () => {
    expect(bodyOf("admit")).toMatch(/const team = await core\.teamStanding\(reader\);[\s\S]*holds\(team\.standing, "config"\)/);
    for (const name of ["publishLegalVersion", "giveLegalCode"]) {
      expect(bodyOf(name), name).toMatch(new RegExp(`^ {2}async function ${name}\\([^)]*(?:\\([^)]*\\)[^)]*)*\\)[^{]*\\{\\n {4}const admitted = await admit\\((?:reader|jar)\\);`));
    }
  });

  it("publicar compara la huella de la vista previa antes de preguntarle a la base", () => {
    expect(bodyOf("publishLegalVersion")).toMatch(/if \(bodyFingerprint\(body\.body\) !== seenSha\) return \{ kind: "preview_stale" \};[\s\S]*store\.publish\(/);
  });

  it("las pantallas llegan por legal-admin.ts, nunca a admin.ts, admin-records.ts ni admin-store.ts", () => {
    const outside = sources.filter((source) => /^src\/(app|jobs)\//.test(source.file) && /services\/legal\/admin(?:-records|-store)?["']/.test(source.text));
    expect(outside.map((source) => source.file)).toEqual([]);
  });

  it("lo que viaja al navegador no importa nada del servidor", () => {
    for (const file of ["outcomes.ts", "screen.tsx"]) {
      const code = codeOf(`src/app/admin/_textos/${file}`);
      expect(code.length, file).toBeGreaterThan(0);
      // Del servicio, solo tipos.
      expect(code, file).not.toMatch(/^import \{[^}]*\} from "@\/services\/legal\/legal-admin";/m);
    }
  });

  it("el servicio y las pantallas tienen dueño en CODEOWNERS", () => {
    const owners = readFileSync(join(src, "..", ".github", "CODEOWNERS"), "utf8");
    expect(owners).toMatch(/^\/src\/services\/legal\/\s+@SerchFGA @plataformaholisticadev$/m);
    expect(owners).toMatch(/^\/src\/app\/admin\/\s+@SerchFGA @plataformaholisticadev$/m);
  });
});
