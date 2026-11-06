import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// El avance de los alumnos de un curso (RF-612, RF-613, RN-15; PA-51; T-408). De cada alumno el maestro ve su alias de PA-51, lo terminado y el total, y
// nada más: ni su identificador, ni su correo o su nombre, ni cuándo se conecta, ni lo que hace con otros maestros. La base ya no los da; esto exige que
// el código tampoco los pida ni los pase a la pantalla.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src)
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file).sort();
const textOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";

const RECORDS = "src/services/teachers/course-students-records.ts";
/** Lo que lee, arma o pinta PA-51. */
const SCREEN = sources
  .map((source) => source.file)
  .filter((file) => /^src\/services\/teachers\/course-students/.test(file) || file.startsWith("src/app/portal/_alumnos/") || file === "src/ui/lesson-funnel.tsx");

describe("el avance de los alumnos no lleva a nadie más", () => {
  it("hay archivos que revisar: el servicio, su lectura, lo armado, la pantalla y su componente", () => {
    expect(SCREEN).toEqual(
      expect.arrayContaining([
        RECORDS,
        "src/services/teachers/course-students.ts",
        "src/services/teachers/course-students-data.ts",
        "src/app/portal/_alumnos/rows.ts",
        "src/app/portal/_alumnos/screen.tsx",
        "src/app/portal/_alumnos/section.tsx",
        "src/ui/lesson-funnel.tsx",
      ]),
    );
  });

  it("su función se nombra en un solo archivo", () => {
    expect(naming(/private\.teacher_course_students\b/)).toEqual([RECORDS]);
  });

  it("nadie de la aplicación nombra el resumen, sus alias ni su paso", () => {
    expect(
      naming(/course_progress_figures|course_lesson_figures|course_student_progress|course_progress_state|course_progress_step|progress_aliases|alias_insert/),
    ).toEqual([]);
  });

  it("ninguna clave por alumno más que el alias, lo terminado y el total", () => {
    for (const file of SCREEN) {
      expect(textOf(file), file).not.toMatch(
        /profile_?[Ii]d|student_?[Ii]d|e_?mail|correo|display_?[Nn]ame|last_?[Aa]ctivity|last_?[Ww]atched|first_?[Ww]atched|completed_?[Aa]t|base_?[Cc]ents|half_?[Pp]oints/,
      );
    }
  });

  it("cada respuesta se lee con forma estricta: una clave de más falla", () => {
    const records = textOf(RECORDS);
    expect(records.match(/z\s*\.object\(/g)?.length).toBeGreaterThan(0);
    expect(records.match(/z\s*\.object\(/g)?.length).toBe(records.match(/\.strict\(\)/g)?.length);
    expect(records).not.toMatch(/\.passthrough\(\)|\.catchall\(|\.loose\(\)|z\.looseObject/);
  });
});
