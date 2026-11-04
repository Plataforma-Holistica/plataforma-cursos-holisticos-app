import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// El reporte del maestro (RN-15; T-604, cuarta solicitud; decisión de Sergio del 2026-11-03). El maestro ve a cada alumno por su alias y sus puntos, y
// nunca su identificador, su base ni sus pesos: con los pesos de cada fila deduciría cuánto ve ese alumno con otros maestros. La base ya no los da; esto
// exige que el código tampoco los pida ni los pase a una pantalla.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src)
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file).sort();
const textOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";

const RECORDS = "src/services/teachers/payout-report-records.ts";
const SERVICE = "src/services/teachers/payout-report.ts";

describe("el reporte del maestro no lleva a nadie más", () => {
  it("sus funciones se nombran en un solo archivo", () => {
    expect(naming(/private\.(?:payouts_mine|payout_report_mine|payout_report_csv_mine)\b/)).toEqual([RECORDS]);
  });

  it("nadie de la aplicación nombra los alias ni las tablas del cierre", () => {
    expect(naming(/student_aliases|payout_shares|payout_student_pools|payout_teacher_totals/)).toEqual([]);
  });

  it("lo que lee de un alumno es alias y puntos, y nada más", () => {
    const records = textOf(RECORDS);
    const students = /students: z\.array\(z\.object\(\{([^}]*)\}\)\.strict\(\)\)/.exec(records);
    expect(students?.[1]?.replace(/\s/g, "")).toBe("alias:z.string(),half_points:z.number().int()");
    for (const file of [RECORDS, SERVICE]) {
      expect(textOf(file), file).not.toMatch(/profile_?[Ii]d|base_?[Cc]ents|student_?[Ii]d/);
    }
    const value = /students: \{([^}]*)\}\[\];/.exec(textOf(SERVICE));
    expect(value?.[1]?.replace(/\s/g, "")).toBe("alias:string;halfPoints:number");
  });

  it("y cada respuesta se lee con forma estricta: una clave de más falla", () => {
    const records = textOf(RECORDS);
    expect(records.match(/z\s*\.object\(/g)?.length).toBe(records.match(/\.strict\(\)/g)?.length);
  });
});
