import { describe, expect, it } from "vitest";

import { signInPath } from "@/services/account/navigation";

import {
  COMMENT_FIELDS,
  IDLE_COMMENTS,
  askState,
  deleteOutcome,
  nameOutcome,
  readCommentForm,
  readCommentLesson,
  writeOutcome,
  type Place,
} from "./comment-outcomes";

// Los comentarios de PA-22 (T-501): qué pide cada botón y qué pinta la pantalla con cada respuesta del servicio. Es puro: la
// acción lo usa para decidir, y la pantalla para pintar.

const ID = "c0000000-0000-4000-8000-000000000001";
const PARENT = "c0000000-0000-4000-8000-000000000002";
const BACK = "/cursos/respirar/lecciones/a0000000-0000-4000-8000-000000000001";
const NEW: Place = { kind: "new" };
const REPLY: Place = { kind: "reply", parentId: PARENT };
const EDIT: Place = { kind: "edit", id: ID };
const BLANK = { open: { kind: "none" }, notice: null, kept: null, written: null } as const;

function form(...values: [string, string][]): FormData {
  const data = new FormData();
  for (const [field, value] of values) data.append(field, value);
  return data;
}

describe("readCommentForm: qué botón se pulsó", () => {
  it("publicar y responder llevan el texto", () => {
    expect(readCommentForm(form(["do", "post"], [COMMENT_FIELDS.body, "Hola"]))).toEqual({ kind: "post", place: NEW, body: "Hola" });
    expect(readCommentForm(form(["do", `reply:${PARENT}`], [COMMENT_FIELDS.body, "Sí"]))).toEqual({ kind: "post", place: REPLY, body: "Sí" });
    expect(readCommentForm(form(["do", "post"]))).toEqual({ kind: "post", place: NEW, body: null });
  });

  it("guardar y borrar llevan el comentario y la revisión que se vio", () => {
    expect(readCommentForm(form(["do", `save:${ID}:3`], [COMMENT_FIELDS.body, "Otro"]))).toEqual({ kind: "save", id: ID, revision: 3, body: "Otro" });
    expect(readCommentForm(form(["do", `delete:${ID}:7`]))).toEqual({ kind: "delete", id: ID, revision: 7 });
  });

  it("las preguntas no escriben: abrir la respuesta, la edición, el borrado, el nombre, y cancelar", () => {
    expect(readCommentForm(form(["do", `open-reply:${PARENT}`]))).toEqual({ kind: "open", open: { kind: "reply", parentId: PARENT } });
    expect(readCommentForm(form(["do", `ask-edit:${ID}`]))).toEqual({ kind: "open", open: { kind: "edit", id: ID } });
    expect(readCommentForm(form(["do", `ask-delete:${ID}`]))).toEqual({ kind: "open", open: { kind: "delete", id: ID } });
    expect(readCommentForm(form(["do", "ask-name"]))).toEqual({ kind: "open", open: { kind: "name", carry: null } });
    expect(readCommentForm(form(["do", "cancel"]))).toEqual({ kind: "open", open: { kind: "none" } });
  });

  it("«Cambiar» va dentro del campo: lo escrito se queda en él mientras se elige el nombre", () => {
    expect(readCommentForm(form(["do", "ask-name"], [COMMENT_FIELDS.body, "Hola"]))).toEqual({
      kind: "open",
      open: { kind: "name", carry: null },
      kept: { at: NEW, body: "Hola" },
    });
    expect(askState({ kind: "open", open: { kind: "name", carry: null }, kept: { at: NEW, body: "Hola" } })).toEqual({
      ...IDLE_COMMENTS,
      open: { kind: "name", carry: null },
      kept: { at: NEW, body: "Hola" },
    });
  });

  it("el nombre lleva lo escrito que cruza el diálogo, y a qué respondía", () => {
    expect(readCommentForm(form(["do", "name"], [COMMENT_FIELDS.name, "Luz"]))).toEqual({ kind: "name", pseudonym: "Luz", carry: null });
    expect(
      readCommentForm(form(["do", "name"], [COMMENT_FIELDS.name, "Luz"], [COMMENT_FIELDS.carry, "Hola"], [COMMENT_FIELDS.carryParent, PARENT])),
    ).toEqual({ kind: "name", pseudonym: "Luz", carry: { parentId: PARENT, body: "Hola" } });
    expect(readCommentForm(form(["do", "name"], [COMMENT_FIELDS.carry, "Hola"]))).toEqual({ kind: "name", pseudonym: null, carry: { parentId: null, body: "Hola" } });
  });

  it("lo que no tiene forma cuenta como vacío", () => {
    for (const value of [
      "",
      "postear",
      "reply:nada",
      `reply:${PARENT.toUpperCase()}`,
      `save:${ID}`,
      `save:${ID}:0`,
      `save:${ID}:-1`,
      `save:${ID}:1.5`,
      `save:${ID}:99999999999999999999`,
      `delete:${ID}:x`,
      `ask-edit:${ID}:1`,
      "x".repeat(200),
    ]) {
      expect(readCommentForm(form(["do", value]))).toEqual({ kind: "none" });
    }
    expect(readCommentForm(form(["do", "post"], ["do", "post"]))).toEqual({ kind: "none" });
    expect(readCommentForm(form())).toEqual({ kind: "none" });
    expect(readCommentForm(null)).toEqual({ kind: "none" });
    // Un texto que cruza con un padre sin forma no cruza a ningún lado.
    expect(readCommentForm(form(["do", "name"], [COMMENT_FIELDS.carry, "Hola"], [COMMENT_FIELDS.carryParent, "x"]))).toEqual({ kind: "none" });
  });
});

describe("readCommentLesson: de qué lección es el formulario", () => {
  const LESSON = "a0000000-0000-4000-8000-000000000001";
  it("el curso y la lección, con forma; si no, ninguna", () => {
    expect(readCommentLesson(form([COMMENT_FIELDS.course, "respirar"], [COMMENT_FIELDS.lesson, LESSON]))).toEqual({ slug: "respirar", lessonId: LESSON, back: BACK });
    expect(readCommentLesson(form([COMMENT_FIELDS.course, "Respirar"], [COMMENT_FIELDS.lesson, LESSON]))).toBeNull();
    expect(readCommentLesson(form([COMMENT_FIELDS.course, "respirar"], [COMMENT_FIELDS.lesson, "x"]))).toBeNull();
    expect(readCommentLesson(form([COMMENT_FIELDS.course, "respirar"]))).toBeNull();
    expect(readCommentLesson(form([COMMENT_FIELDS.course, "respirar"], [COMMENT_FIELDS.course, "otro"], [COMMENT_FIELDS.lesson, LESSON]))).toBeNull();
    expect(readCommentLesson(null)).toBeNull();
  });
});

describe("askState: abrir y cerrar no llaman a nadie", () => {
  it("abre lo pedido y olvida el aviso y lo que se quedaba", () => {
    expect(askState({ kind: "open", open: { kind: "reply", parentId: PARENT } })).toEqual({ ...IDLE_COMMENTS, open: { kind: "reply", parentId: PARENT } });
    expect(askState({ kind: "open", open: { kind: "none" } })).toEqual(IDLE_COMMENTS);
  });
});

describe("writeOutcome: lo que pinta la pantalla después de publicar o editar", () => {
  it("publicado o en revisión: se cierra lo abierto, se dice, y el foco va al comentario", () => {
    expect(writeOutcome(NEW, "Hola", { kind: "written", id: ID, state: "published" }, BACK)).toEqual({
      kind: "state",
      refresh: true,
      state: { open: { kind: "none" }, notice: { at: { kind: "comment", id: ID }, kind: "published" }, kept: null, written: ID },
    });
    expect(writeOutcome(EDIT, "Hola", { kind: "written", id: ID, state: "in_review" }, BACK)).toMatchObject({
      state: { notice: { at: { kind: "comment", id: ID }, kind: "in_review" }, written: ID },
    });
  });

  it("sin seudónimo, el diálogo del nombre, con lo escrito y a qué respondía", () => {
    expect(writeOutcome(REPLY, "Hola", { kind: "gate", answer: "needs_pseudonym" }, BACK)).toEqual({
      kind: "state",
      refresh: false,
      // Lo escrito se queda también en su campo: si cancela el diálogo, no se pierde.
      state: { open: { kind: "name", carry: { parentId: PARENT, body: "Hola" } }, notice: null, kept: { at: REPLY, body: "Hola" }, written: null },
    });
  });

  it("lo que no se pudo publicar se dice en su campo, y el texto se queda", () => {
    for (const result of [
      { kind: "throttled" },
      { kind: "invalid", reason: "invalid" },
      { kind: "bad_parent" },
      { kind: "unavailable" },
      { kind: "read_only" },
      { kind: "gate", answer: "banned" },
      { kind: "gate", answer: "closed" },
      { kind: "gate", answer: "suspended" },
      { kind: "gate", answer: "needs_notice" },
    ] as const) {
      const outcome = writeOutcome(REPLY, "Hola", result, BACK);
      expect(outcome).toMatchObject({ kind: "state", state: { open: { kind: "reply", parentId: PARENT }, kept: { at: REPLY, body: "Hola" }, written: null } });
      expect(outcome.kind === "state" && outcome.state.notice?.at).toEqual(REPLY);
    }
    expect(writeOutcome(NEW, "Hola", { kind: "invalid", reason: "too_long" }, BACK)).toMatchObject({ state: { notice: { at: NEW, kind: "too_long" } } });
    expect(writeOutcome(NEW, "Hola", { kind: "invalid", reason: "empty" }, BACK)).toMatchObject({ state: { notice: { at: NEW, kind: "empty" } } });
    expect(writeOutcome(NEW, "Hola", { kind: "gate", answer: "banned" }, BACK)).toMatchObject({ state: { notice: { kind: "banned" }, open: { kind: "none" } } });
  });

  it("si otra pestaña lo cambió o se borró, la edición se cierra y lo escrito no vuelve", () => {
    expect(writeOutcome(EDIT, "Hola", { kind: "changed" }, BACK)).toEqual({
      kind: "state",
      refresh: true,
      state: { open: { kind: "none" }, notice: { at: { kind: "comment", id: ID }, kind: "changed" }, kept: null, written: null },
    });
    expect(writeOutcome(EDIT, "Hola", { kind: "not_found" }, BACK)).toMatchObject({ state: { open: { kind: "none" }, notice: { at: { kind: "thread" }, kind: "gone" }, kept: null } });
  });

  it("si la lección ya no se ve, se dice arriba del hilo", () => {
    for (const result of [{ kind: "not_found" }, { kind: "no_access", account: { allowed: false, reason: "no_basis" } }, { kind: "gate", answer: "not_found" }] as const) {
      expect(writeOutcome(NEW, "Hola", result as never, BACK)).toMatchObject({ kind: "state", refresh: true, state: { notice: { at: { kind: "thread" } } } });
    }
  });

  it("la sesión que no pasa sale de la pantalla y vuelve a la lección", () => {
    expect(writeOutcome(NEW, "Hola", { kind: "session", check: { kind: "anonymous" } }, BACK)).toEqual({
      kind: "redirect",
      to: signInPath(BACK),
      notice: null,
      closeSession: false,
    });
    expect(writeOutcome(NEW, "Hola", { kind: "session", check: { kind: "suspended" } } as never, BACK)).toMatchObject({ kind: "redirect", to: BACK });
    expect(writeOutcome(NEW, "Hola", { kind: "session", check: { kind: "must_sign_out", then: "sign_in" } } as never, BACK)).toMatchObject({
      kind: "redirect",
      closeSession: true,
    });
    expect(writeOutcome(NEW, "Hola", { kind: "session", check: { kind: "unavailable" } }, BACK)).toMatchObject({
      kind: "state",
      state: { notice: { at: NEW, kind: "unavailable" }, kept: { at: NEW, body: "Hola" } },
    });
  });
});

describe("deleteOutcome: lo que pinta la pantalla después de borrar", () => {
  it("borrado, ya no estaba, o cambiado en otra pestaña", () => {
    expect(deleteOutcome(ID, { kind: "deleted" }, BACK)).toEqual({ kind: "state", refresh: true, state: { ...BLANK, notice: { at: { kind: "thread" }, kind: "deleted" } } });
    expect(deleteOutcome(ID, { kind: "not_found" }, BACK)).toMatchObject({ refresh: true, state: { notice: { at: { kind: "thread" }, kind: "gone" } } });
    expect(deleteOutcome(ID, { kind: "changed" }, BACK)).toMatchObject({ refresh: true, state: { open: { kind: "none" }, notice: { at: { kind: "comment", id: ID }, kind: "changed" } } });
  });

  it("si no se supo, la pregunta se queda para reintentar", () => {
    expect(deleteOutcome(ID, { kind: "unavailable" }, BACK)).toMatchObject({ state: { open: { kind: "delete", id: ID }, notice: { at: { kind: "comment", id: ID }, kind: "unavailable" } } });
    expect(deleteOutcome(ID, { kind: "session", check: { kind: "anonymous" } }, BACK)).toMatchObject({ kind: "redirect" });
  });
});

describe("nameOutcome: lo que pinta la pantalla después de elegir el nombre", () => {
  it("guardado con algo que cruzaba: se publica; sin nada, se dice", () => {
    expect(nameOutcome({ kind: "saved", pseudonym: "Luz" }, "Luz", { parentId: null, body: "Hola" }, BACK)).toEqual({ kind: "post", place: NEW, body: "Hola" });
    expect(nameOutcome({ kind: "saved", pseudonym: "Luz" }, "Luz", { parentId: PARENT, body: "Hola" }, BACK)).toEqual({ kind: "post", place: REPLY, body: "Hola" });
    expect(nameOutcome({ kind: "saved", pseudonym: "Luz" }, "Luz", null, BACK)).toEqual({ kind: "state", refresh: true, state: { ...BLANK, notice: { at: { kind: "thread" }, kind: "name_saved" } } });
  });

  it("un nombre que no sirve deja el diálogo abierto, con lo escrito y lo que cruzaba", () => {
    const carry = { parentId: null, body: "Hola" };
    expect(nameOutcome({ kind: "invalid", reason: "too_short" }, "L", carry, BACK)).toEqual({
      kind: "state",
      refresh: false,
      state: { open: { kind: "name", carry }, notice: { at: { kind: "name" }, kind: "name_too_short" }, kept: { at: { kind: "name" }, body: "L" }, written: null },
    });
    expect(nameOutcome({ kind: "unavailable" }, "Luz", carry, BACK)).toMatchObject({ state: { open: { kind: "name", carry }, notice: { kind: "unavailable" } } });
  });

  it("con el veto o cerrado, el diálogo se cierra y lo que cruzaba vuelve a su campo", () => {
    expect(nameOutcome({ kind: "banned" }, "Luz", { parentId: PARENT, body: "Hola" }, BACK)).toEqual({
      kind: "state",
      refresh: true,
      state: { open: { kind: "reply", parentId: PARENT }, notice: { at: REPLY, kind: "banned" }, kept: { at: REPLY, body: "Hola" }, written: null },
    });
    expect(nameOutcome({ kind: "closed" }, "Luz", null, BACK)).toMatchObject({ state: { open: { kind: "none" }, notice: { at: { kind: "thread" }, kind: "closed" }, kept: null } });
  });
});
