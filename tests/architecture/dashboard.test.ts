import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// El panel del maestro (RF-601, RF-602, RF-612, RN-15; PA-41; T-408). El maestro ve sus cifras del mes, por curso y por periodo, y nunca algo de un
// alumno (su identificador, su base, lo que le toca de él en pesos) ni el porcentaje del bote: con pocos alumnos, cualquiera de esos dice cuánto ve un
// alumno con otros maestros. La base ya no los da; esto exige que el código tampoco los pida ni los pase a una pantalla.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src)
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file).sort();
const textOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";

const RECORDS = "src/services/teachers/dashboard-records.ts";
/** Lo que lee, arma o pinta el panel. */
const PANEL = sources
  .map((source) => source.file)
  .filter((file) => /^src\/services\/teachers\/dashboard/.test(file) || file.startsWith("src/app/portal/_inicio/") || file === "src/app/portal/page.tsx");

describe("el panel del maestro no lleva a nadie más", () => {
  it("hay archivos que revisar: el servicio, su lectura, lo armado y la pantalla", () => {
    expect(PANEL).toEqual(
      expect.arrayContaining([RECORDS, "src/services/teachers/dashboard.ts", "src/services/teachers/dashboard-data.ts", "src/app/portal/page.tsx", "src/app/portal/_inicio/outcomes.ts"]),
    );
  });

  it("su función se nombra en un solo archivo", () => {
    expect(naming(/private\.teacher_dashboard\b/)).toEqual([RECORDS]);
  });

  it("nadie de la aplicación nombra las tablas del estimado", () => {
    expect(naming(/teacher_estimate_runs|teacher_period_estimates|teacher_period_course_figures|teacher_estimates_step/)).toEqual([]);
  });

  it("ninguna clave por alumno: ni su identificador, ni su base, ni sus pesos", () => {
    for (const file of PANEL) {
      expect(textOf(file), file).not.toMatch(/profile_?[Ii]d|student_?[Ii]d|base_?[Cc]ents|student_?[Cc]ents|students?_?[Ss]hare|share_?[Cc]ents|alias/);
    }
  });

  it("y ningún porcentaje del bote", () => {
    for (const file of PANEL) expect(textOf(file), file).not.toMatch(/pool_?[Bb]ps|bps\b/);
  });

  it("cada respuesta se lee con forma estricta: una clave de más falla", () => {
    const records = textOf(RECORDS);
    expect(records.match(/z\s*\.object\(/g)?.length).toBeGreaterThan(0);
    expect(records.match(/z\s*\.object\(/g)?.length).toBe(records.match(/\.strict\(\)/g)?.length);
    expect(records).not.toMatch(/\.passthrough\(\)|\.catchall\(|\.loose\(\)|z\.looseObject/);
  });
});
