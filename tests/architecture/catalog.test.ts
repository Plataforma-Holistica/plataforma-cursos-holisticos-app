import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// Las prácticas y los niveles (T-106): por dónde se le pregunta a la base y quién decide.
// Lo que hace cada respuesta lo prueban `src/services/catalog/*.test.ts`; aquí, la forma.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";
const lists = codeOf("src/services/catalog/lists.ts");
const store = codeOf("src/services/catalog/store.ts");
const records = codeOf("src/services/catalog/records.ts");

const bodyOf = (name: string) => {
  const start = lists.indexOf(`  async function ${name}(`);
  const end = lists.indexOf("\n  }\n", start);
  return start === -1 || end === -1 ? "" : lists.slice(start, end);
};

describe("las listas del catálogo pasan por las funciones de la base", () => {
  it("hay archivos que revisar", () => {
    for (const code of [lists, store, records]) expect(code.length).toBeGreaterThan(0);
  });

  it.each(["catalog_add", "catalog_rename", "catalog_move", "catalog_set_active", "catalog_lists"])(
    "private.%s() se nombra en un solo archivo, una vez",
    (name) => {
      const naming = sources.filter((source) => new RegExp(`private\\.${name}\\b`).test(source.text)).map((source) => source.file);
      expect(naming).toEqual(["src/services/catalog/records.ts"]);
      expect(records.match(new RegExp(`private\\.${name}\\(`, "g"))).toHaveLength(1);
    },
  );

  it("nadie de la aplicación nombra las tablas: se leen y se escriben por las funciones", () => {
    const naming = sources.filter((source) => /\b(?:public\.)?(?:practices|levels)\b\s*(?:where|set|values|\()/i.test(source.text)).map((source) => source.file);
    expect(naming).toEqual([]);
    expect(records).not.toMatch(/from public\.(?:practices|levels)/);
  });

  it("el almacén abre sus transacciones como servidor, y solo así", () => {
    expect(store).toMatch(/import \{ asServer, type Tx \} from "@\/adapters\/supabase\/db";/);
    expect(store).not.toMatch(/\bas(?:User|System)\b/);
    expect(records).not.toMatch(/\bas(?:Server|User|System)\(/);
  });

  it("el servicio no abre transacciones ni lee la base por su cuenta", () => {
    expect(lists).not.toMatch(/adapters\/supabase\/db|adapters\/supabase\/auth["']/);
    expect(lists).not.toMatch(/\bas(?:User|Server|System)\(/);
  });

  // Dar el código pasa dos veces por la guarda: antes, y después de verificar, porque
  // verificar escribió la cookie. Cada paso es su propia función.
  it.each(["addItem", "renameItem", "moveItem", "setItemActive", "giveCatalogCode", "freshAfterCode"])(
    "%s corre la guarda antes que cualquier otra cosa",
    (name) => {
      expect(bodyOf(name)).toMatch(
        new RegExp(
          `^  async function ${name}\\([^)]*\\): Promise<\\w+> \\{\\s+const admitted = await admit\\((?:reader|jar)\\);\\s+if \\(!admitted\\.ok\\) return admitted\\.result;`,
        ),
      );
    },
  );

  it("la guarda pide Contenido, no otra capacidad", () => {
    expect(bodyOf("admit")).toMatch(/!holds\(team\.standing, "content"\)/);
    expect(lists.match(/holds\(/g)).toHaveLength(1);
  });

  it("quien actúa sale de la sesión que pasó la guarda, nunca de lo que llega", () => {
    for (const call of lists.match(/store\.\w+\([^)]*\)/g) ?? []) {
      expect(call).toMatch(/^store\.\w+\((?:admitted\.)?claims\b/);
    }
    expect(lists).not.toMatch(/input\.(?:actor|claims|session|userId)/);
  });

  it("la lista llega a la base por su tipo enumerado, nunca armada con texto", () => {
    for (const query of records.match(/sql`[^`]*`/g) ?? []) {
      if (/catalog_(?:add|rename|move|set_active)/.test(query)) expect(query).toMatch(/::text::public\.catalog_list/);
      expect(query).not.toMatch(/\$\{(?!\w+\})/);
    }
  });

  it("los cambios a las listas tienen dueño en CODEOWNERS", () => {
    const owners = readFileSync(join(src, "..", ".github", "CODEOWNERS"), "utf8");
    expect(owners).toMatch(/^\/src\/services\/catalog\/\s+@SerchFGA @plataformaholisticadev$/m);
  });
});
