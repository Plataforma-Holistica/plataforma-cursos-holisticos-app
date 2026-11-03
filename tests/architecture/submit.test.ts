import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// T-405, tercera solicitud: enviar a revisión desde el portal (PA-44), por un solo camino. Las funciones de enviar se nombran en un solo archivo; las dos tablas de la prueba
// (`course_reviews` y `licenses`) no las nombra ningún código de la aplicación: solo las funciones de la base las leen. Enviar corre la guarda antes que nada, y el origen sale de la
// petición. Reemplaza a la prueba de la primera solicitud, que exigía que nadie llegara a enviar.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), code: withoutComments(readFileSync(path, "utf8")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.code ?? "";
const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.code)).map((source) => source.file);

describe("enviar pasa por un solo camino", () => {
  it("hay código que revisar", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(codeOf("src/services/drafts/submit.ts").length).toBeGreaterThan(0);
  });

  it("las funciones de enviar se nombran en un solo archivo", () => {
    expect(naming(/private\.course_submit\w*\b/)).toEqual(["src/services/drafts/records.ts"]);
  });

  it.each(["course_reviews", "licenses"])("ningún código de la aplicación nombra %s", (name) => {
    expect(naming(new RegExp(`\\b${name}\\b`))).toEqual([]);
  });

  it("enviar corre la guarda antes que cualquier otra cosa", () => {
    const service = codeOf("src/services/drafts/submit.ts");
    expect(service).toMatch(/ {2}async function submitCourse\([^)]*\)[^{]*\{\n {4}const check = await deps\.checkSession\(reader\);/);
  });

  it("la casilla se mira antes de preguntarle a la base, y Mux antes de firmar", () => {
    const service = codeOf("src/services/drafts/submit.ts");
    const accepted = service.indexOf("if (input.accepted !== true)");
    const assets = service.indexOf("deps.store.assets(");
    const ready = service.indexOf("await videosNotReady(");
    const submit = service.indexOf("deps.store.submit(");
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(assets);
    expect(assets).toBeLessThan(ready);
    expect(ready).toBeLessThan(submit);
  });

  it("la única pantalla que envía es PA-44, y el origen sale de la petición", () => {
    expect(naming(/\bsubmitCourse\(/).filter((file) => file.startsWith("src/app/"))).toEqual(["src/app/portal/_enviar/actions.ts"]);
    expect(codeOf("src/app/portal/_enviar/actions.ts")).toMatch(/await requestOrigin\(\)/);
  });
});
