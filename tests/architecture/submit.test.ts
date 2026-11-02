import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// T-405, primera solicitud: la firma existe en la base, y todavía nadie de la aplicación puede llegar a ella. Firmar no se ofrece antes de que
// exista cómo salir de la revisión (la segunda solicitud), y la tercera, que trae PA-44, cambia esta prueba por la de su camino.

const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: readFileSync(path, "utf8") }));

describe("nadie de la aplicación llega a enviar", () => {
  it("hay código que revisar", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(["course_submit", "course_submit_preview", "course_reviews", "licenses"])("la aplicación no nombra %s", (name) => {
    const naming = sources.filter((source) => new RegExp(`\\b${name}\\b`).test(source.text)).map((source) => source.file);
    expect(naming).toEqual([]);
  });
});
