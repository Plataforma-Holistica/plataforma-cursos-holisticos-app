import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// El catálogo del alumno (T-210) y Mi lista (RF-311; decisión de Sergio del 2026-10-28): lo de
// cada quien se lee como la persona, y la lista la escribe el servidor después de la guarda de
// sesión, a nombre de la sesión que pasó. Lo que hace cada respuesta lo prueba
// `src/services/browse/browse.test.ts`; aquí, por dónde se le pregunta a la base.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8").replaceAll("\r", "")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";
const browse = codeOf("src/services/browse/browse.ts");
const records = codeOf("src/services/browse/records.ts");

const bodyOf = (name: string) => {
  const start = browse.indexOf(`  function ${name}(`) === -1 ? browse.indexOf(`  async function ${name}(`) : browse.indexOf(`  function ${name}(`);
  const end = browse.indexOf("\n  }\n", start);
  return start === -1 || end === -1 ? "" : browse.slice(start, end);
};
const storeOf = (name: string) => browse.match(new RegExp(`^  ${name}: \\([^)]*\\) =>[\\s\\S]*?\\),\\n`, "m"))?.[0] ?? "";

describe("Mi lista pasa por la guarda y por la base como debe", () => {
  it("hay archivos que revisar", () => {
    for (const code of [browse, records]) expect(code.length).toBeGreaterThan(0);
  });

  it("la tabla la nombran solo las consultas del catálogo", () => {
    const naming = sources.filter((source) => /\bsaved_courses\b/.test(source.text)).map((source) => source.file);
    expect(naming).toEqual(["src/services/browse/records.ts"]);
  });

  it("lo de cada quien se lee como la persona", () => {
    expect(storeOf("myCourse")).toMatch(/^  myCourse: \(claims, slug\) =>\s+asUser\(claims, /);
    expect(storeOf("mySavedCourses")).toMatch(/^  mySavedCourses: \(claims\) => asUser\(claims, \(tx\) => readMySavedCourses\(tx\)\),/);
  });

  it("guardar y quitar los escribe el servidor, a nombre de las claims de la guarda", () => {
    expect(storeOf("saveCourse")).toMatch(/^  saveCourse: \(claims, slug\) => asServer\(\{ claims, reason: "save_course" \}, \(tx\) => saveListedCourse\(tx, slug\)\),/);
    expect(storeOf("removeCourse")).toMatch(/^  removeCourse: \(claims, slug\) => asServer\(\{ claims, reason: "remove_course" \}, \(tx\) => removeSavedCourse\(tx, slug\)\),/);
    expect(browse.match(/\basServer\(/g)).toHaveLength(2);
  });

  it("los dos corren la guarda antes de escribir, y escriben con sus claims", () => {
    expect(bodyOf("changeList")).toMatch(
      /const check = await deps\.checkSession\(reader\);\s+if \(check\.kind !== "pass"\) return \{ kind: "session", check \};\s+try \{\s+return await write\(check\.claims\);/,
    );
    expect(bodyOf("saveCourse")).toMatch(/return changeList\(reader, slug, /);
    expect(bodyOf("removeCourse")).toMatch(/return changeList\(reader, slug, /);
  });

  it("ninguna cuenta llega de fuera: la base escribe a nombre de quien actúa", () => {
    const writes = records.slice(records.indexOf("export async function saveListedCourse"));
    expect(writes).toMatch(/select private\.actor_id\(\), course\.course_id from course/);
    expect(writes).toMatch(/s\.profile_id = private\.actor_id\(\)/);
    expect(writes).not.toMatch(/profile_id\s*=\s*\$\{/);
    expect(writes).not.toMatch(/values\s*\(\s*\$\{/);
  });

  it("lo que la persona lee pide sus filas también en la consulta", () => {
    const reads = records.slice(records.indexOf("export async function readMySavedCourses"), records.indexOf("export async function saveListedCourse"));
    expect(reads.match(/s\.profile_id = \(select auth\.uid\(\)\)/g)).toHaveLength(2);
  });
});
