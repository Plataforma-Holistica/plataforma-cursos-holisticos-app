import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// La revisión de cursos (T-108): por dónde se le pregunta a la base y quién decide. Lo que hace
// cada respuesta lo prueban `src/services/review/*.test.ts`; aquí, la forma.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";
const queue = codeOf("src/services/review/queue.ts");
const store = codeOf("src/services/review/store.ts");
const records = codeOf("src/services/review/records.ts");

const bodyOf = (name: string) => {
  const start = queue.indexOf(`  async function ${name}(`);
  const end = queue.indexOf("\n  }\n", start);
  return start === -1 || end === -1 ? "" : queue.slice(start, end);
};

describe("la revisión pasa por las funciones de la base", () => {
  it("hay archivos que revisar", () => {
    for (const code of [queue, store, records]) expect(code.length).toBeGreaterThan(0);
  });

  it.each(["approve_course", "review_queue", "review_return", "review_approve", "review_approve_assets"])("private.%s() se nombra en un solo archivo, una vez", (name) => {
    const naming = sources.filter((source) => new RegExp(`private\\.${name}\\b`).test(source.text)).map((source) => source.file);
    expect(naming).toEqual(["src/services/review/records.ts"]);
    expect(records.match(new RegExp(`private\\.${name}\\(`, "g"))).toHaveLength(1);
  });

  it("el almacén abre sus transacciones como servidor, y solo así", () => {
    expect(store).toMatch(/import \{ asServer \} from "@\/adapters\/supabase\/db";/);
    expect(store).not.toMatch(/\bas(?:User|System)\b/);
    expect(records).not.toMatch(/\bas(?:Server|User|System)\(/);
  });

  it("el servicio no abre transacciones ni lee la base por su cuenta", () => {
    expect(queue).not.toMatch(/adapters\/supabase\/db|adapters\/supabase\/auth["']/);
    expect(queue).not.toMatch(/\bas(?:User|Server|System)\(/);
  });

  it("aprobar corre la guarda antes que cualquier otra cosa", () => {
    expect(bodyOf("approveCourse")).toMatch(
      /^ {2}async function approveCourse\([^)]*\): Promise<CourseApproved> \{\n {4}const team = await core\.teamStanding\(reader\);/,
    );
  });

  it("aprobar lo enviado corre la guarda primero, y le pregunta a Mux después de leer los videos y antes de aprobar (T-405)", () => {
    const body = bodyOf("approveSubmission");
    expect(body).toMatch(/^ {2}async function approveSubmission\([^)]*\): Promise<SubmissionApproved> \{\n {4}const team = await core\.teamStanding\(reader\);/);
    const assets = body.indexOf("core.store.approveAssets(");
    const checked = body.indexOf("await checkAssets(");
    const approve = body.indexOf("core.store.approveSubmission(");
    expect(assets).toBeGreaterThan(0);
    expect(assets).toBeLessThan(checked);
    expect(checked).toBeLessThan(approve);
  });

  it("devolver corre la guarda antes que cualquier otra cosa", () => {
    expect(bodyOf("returnCourse")).toMatch(/^ {2}async function returnCourse\([^)]*\): Promise<CourseReturned> \{\n {4}const team = await core\.teamStanding\(reader\);/);
  });

  it("lo que lee el maestro y la puerta de los recursos se nombran en un solo archivo", () => {
    const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file);
    expect(naming(/private\.course_return_notes\b/)).toEqual(["src/services/drafts/records.ts"]);
    expect(naming(/private\.review_resource_object\b/)).toEqual(["src/services/media/records.ts"]);
  });

  it("las pantallas llegan por review.ts, nunca a queue.ts, store.ts ni records.ts", () => {
    const outside = sources.filter((source) => /^src\/(app|jobs)\//.test(source.file) && /services\/review\/(?!review\b)/.test(source.text));
    expect(outside.map((source) => source.file)).toEqual([]);
  });
});
