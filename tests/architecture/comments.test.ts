import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// Los comentarios por lección (T-501). La base no mira el acceso: la única defensa es que el servidor corra la regla única
// en la misma transacción en que llama a la base, con el nivel que pide cada entrada. Lo que contesta cada respuesta lo
// prueba `src/services/comments/comments.test.ts`, y contra la base, la integración 102; aquí, que el camino no cambie.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8").replaceAll("\r", "")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";
const flat = (text: string) => text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file);

const service = flat(codeOf("src/services/comments/comments.ts"));
const records = codeOf("src/services/comments/records.ts");
const media = flat(codeOf("src/services/media/records.ts"));

/** La entrada `name` del almacén de la base, hasta la siguiente. */
const storeOf = (name: string) => {
  const store = service.slice(service.indexOf("export function commentsStoreOn"));
  return store.match(new RegExp(` ${name}: \\(claims(?:, [^)]*)?\\) => .*?(?= \\w+: \\(claims| \\}; \\})`))?.[0] ?? "";
};
const bodyOf = (name: string) => service.match(new RegExp(`async function ${name}(?:<[^>]*>)?\\(.*?(?= async function | return \\{ lessonComments)`))?.[0] ?? "";

describe("los comentarios pasan por la regla y por la base como deben", () => {
  it("hay archivos que revisar", () => {
    for (const code of [service, records, media]) expect(code.length).toBeGreaterThan(0);
  });

  it("las funciones de la base las nombra un solo archivo, y las tablas ninguno", () => {
    expect(naming(/\bprivate\.comments?_/)).toEqual(["src/services/comments/records.ts"]);
    expect(naming(/\bpublic\.(?:comments|profile_privacy)\b|\bprofile_privacy\b/)).toEqual([]);
    // Al servicio solo lo importan las pantallas, nunca otro servicio.
    expect(naming(/@\/services\/comments\//).filter((file) => file.startsWith("src/services/"))).toEqual([]);
  });

  it("los hechos son los de ver, sin el playback id ni el correo", () => {
    const comments = sources.filter((source) => source.file.startsWith("src/services/comments/"));
    expect(comments.map((source) => source.file).sort()).toEqual([
      "src/services/comments/comments.ts",
      "src/services/comments/moderation.ts",
      "src/services/comments/records.ts",
    ]);
    for (const source of comments) {
      expect(source.text).not.toMatch(/readWatchFacts|watchFacts|lesson_playback|playback|email|signDownload/);
    }
    const read = media.match(/export async function readCommentFacts\(.*?\n?(?= export )/)?.[0] ?? "";
    expect(read).toMatch(/sql`select private\.media_facts\(\$\{lessonId\}::uuid\) as facts`/);
    expect(read).not.toMatch(/\.email\b|lesson_playback|playback/);
  });

  it("al modelo de moderación le llega solo el texto, y solo lo llama el servicio (T-502; ADR-30)", () => {
    expect(naming(/["']\.\/moderation["']|@\/services\/comments\/moderation/)).toEqual(["src/services/comments/comments.ts"]);
    expect(service.match(/\w+\.classify\([^)]*\)/g)).toEqual(["moderation.classify(text)"]);
    expect(bodyOf("settled")).toMatch(/verdictOf\(moderation, text\)/);
    // El texto que se filtra es el que se escribió, ya revisado: el mismo que llega a la base.
    expect(service).toContain('writeOf(await deps.store.post(claims, { lessonId, parentId, body: body.text }), "post", claims, body.text)');
    expect(service).toContain('writeOf(answer, "edit", claims, body.text)');
    // Asentar no pasa por la regla: la base asienta solo lo propio que sigue en el filtro con esa revisión.
    expect(storeOf("settle")).toBe(' settle: (claims, input) => run(claims, "comment_settle", (tx) => settleComment(tx, input)),');
  });

  it("la regla es la única, con los hechos de la base y su hora", () => {
    expect(service).toContain(
      "const decideComment = (facts: CommentFacts | null): CommentAccess => facts === null ? { ok: false, reason: \"unknown\" } : resolveCommentAccess(facts.viewer, resolveAccountAccess(facts.account, facts.now, { graceDays: facts.graceDays }), facts.lesson);",
    );
    expect(bodyOf("guarded")).toContain(
      "const access = decideComment(await readCommentFacts(tx, lessonId)); if (!commentAllows(access, needed)) return { kind: \"refused\", access }; return { kind: \"ran\", value: await run(access) };",
    );
    expect(service.match(/decideComment\(/g)).toHaveLength(1);
    expect(service.match(/readCommentFacts\(/g)).toHaveLength(1);
  });

  it("cada entrada pide su nivel, en la misma transacción que la base", () => {
    expect(service.match(/guarded\(tx,/g)).toHaveLength(4);
    // La aplicación corre cada entrada como servidor, en una transacción.
    // Y como la persona solo los cursos del filtro de PA-45.
    expect(service).toContain("export const databaseCommentsStore = commentsStoreOn((claims, reason, work) => asServer({ claims, reason }, work), asUser);");
    expect(service.match(/\basUser\b/g)).toHaveLength(2);
    expect(service.match(/\basServer\(/g)).toHaveLength(1);
    expect(storeOf("lesson")).toMatch(/^ lesson: \(claims, lessonId, before\) => run\(claims, "comments_read", \(tx\) => guarded\(tx, lessonId, "read", /);
    expect(storeOf("lesson")).toContain('canWrite: commentAllows(access, "write") ? await readCanWrite(tx, lessonId) : null');
    expect(storeOf("replies")).toMatch(
      /^ replies: \(claims, lessonId, parentId, after\) => run\(claims, "comments_read", \(tx\) => guarded\(tx, lessonId, "read", \(\) => readCommentReplies\(tx, lessonId, parentId, after\)\)\),$/,
    );
    expect(storeOf("post")).toBe(' post: (claims, input) => run(claims, "comment_post", (tx) => guarded(tx, input.lessonId, "write", () => postComment(tx, input))),');
    // Editar decide con la lección que da la base, nunca con una del formulario.
    expect(storeOf("edit")).toBe(
      ' edit: (claims, input) => run(claims, "comment_edit", async (tx) => { const lessonId = await readCommentLesson(tx, input.commentId); return lessonId === null ? { kind: "missing" as const } : guarded(tx, lessonId, "write", () => editComment(tx, input)); }),',
    );
    // Borrar y el seudónimo, solo con la sesión: lo propio siempre se borra, y la base mira la cuenta y el veto.
    expect(storeOf("remove")).toBe(' remove: (claims, input) => run(claims, "comment_delete", (tx) => deleteComment(tx, input)),');
    expect(storeOf("pseudonym")).toBe(' pseudonym: (claims, pseudonym) => run(claims, "comment_pseudonym", (tx) => setPseudonym(tx, pseudonym)),');
    // «Mis comentarios» (PA-24), también solo con la sesión: es lo propio, y la base solo da lo de quien actúa.
    expect(storeOf("mine")).toBe(' mine: (claims, before) => run(claims, "comments_mine", (tx) => readMyComments(tx, before)),');
    expect(bodyOf("myComments")).not.toMatch(/guarded|readCommentFacts|decideComment|commentAllows/);
    expect(service.match(/deps\.store\.mine\(/g)).toHaveLength(1);
    // PA-45, también sin la regla (decisión de Sergio del 2026-11-08): la base acota al maestro de quien actúa. Si puede responder lo
    // dice el portón, con la lección del primer comentario, en la misma transacción.
    expect(storeOf("teacher")).toMatch(/^ teacher: \(claims, input\) => run\(claims, "comments_teacher", async \(tx\) => \{ const comments = await readTeacherComments\(tx, input\);/);
    expect(storeOf("teacher")).toContain("canWrite: first === undefined ? null : await readCanWrite(tx, first.lessonId)");
    expect(bodyOf("teacherComments")).not.toMatch(/guarded|readCommentFacts|decideComment|commentAllows/);
    // Los cursos del filtro, como la persona: su maestro lee lo suyo, como en Mis cursos.
    expect(storeOf("teacherCourses")).toBe(' teacherCourses: (claims) => read(claims, (tx) => readTeacherCommentCourses(tx)),');
    // Cada consulta se llama una sola vez, desde su entrada.
    for (const call of ["readLessonComments", "readCommentReplies", "readCommentLesson", "postComment", "editComment", "deleteComment", "setPseudonym", "readMyComments", "readTeacherComments", "readTeacherCommentCourses"]) {
      expect(service.match(new RegExp(`\\b${call}\\(`, "g")), call).toHaveLength(1);
    }
    // El portón se pregunta desde la lección (PA-22) y desde el portal (PA-45).
    expect(service.match(/\breadCanWrite\(/g)).toHaveLength(2);
    expect(records).not.toMatch(/editComment\(tx: Tx, input: \{ lessonId/);
  });

  it("las escrituras corren la guarda de sesión y revisan el texto antes de la base", () => {
    expect(bodyOf("withSession")).toMatch(/^async function withSession<T>\(reader: CookieReader, .*?\{ const check = await deps\.checkSession\(reader\); if \(check\.kind !== "pass"\) return \{ kind: "session", check \};/);
    for (const [name, store] of [
      ["postLessonComment", "post"],
      ["editLessonComment", "edit"],
      ["deleteLessonComment", "remove"],
      ["chooseCommentName", "pseudonym"],
    ] as const) {
      expect(bodyOf(name), name).toMatch(new RegExp(`return withSession\\(reader, async \\(claims\\) => .*deps\\.store\\.${store}\\(claims, `));
      expect(service.match(new RegExp(`deps\\.store\\.${store}\\(`, "g")), store).toHaveLength(1);
    }
    expect(bodyOf("postLessonComment")).toMatch(/const body = parseCommentBody\(input\.body\); if \(!body\.ok\) return/);
    expect(bodyOf("postLessonComment")).toContain("body: body.text");
    expect(bodyOf("editLessonComment")).toMatch(/const body = parseCommentBody\(input\.body\); if \(!body\.ok\) return/);
    expect(bodyOf("chooseCommentName")).toMatch(/const name = parsePseudonym\(input\); if \(!name\.ok\) return/);
  });
});
