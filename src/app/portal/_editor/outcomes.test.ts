import { describe, expect, it } from "vitest";

import { editorButton, moveTarget, readEditorForm } from "./outcomes";

// Lo que llega de cada formulario del editor (PA-43; T-402): qué botón se pulsó, de qué curso y con qué
// revisión. Lo que no tiene forma no es nada.

const COURSE = "c0000000-0000-4000-8000-000000000001";
const MODULE = "d0000000-0000-4000-8000-000000000001";
const OTHER = "d0000000-0000-4000-8000-000000000002";
const LESSON = "e0000000-0000-4000-8000-000000000001";
const PRACTICE = "f0000000-0000-4000-8000-000000000001";
const LEVEL = "f0000000-0000-4000-8000-000000000002";

const form = (entries: [string, string][]) => {
  const data = new FormData();
  data.append("course", COURSE);
  for (const [name, value] of entries) data.append(name, value);
  return data;
};

describe("readEditorForm", () => {
  it.each([
    [
      "guardar los datos",
      [["do", editorButton.saveCourse(3)], ["title", "Respirar"], ["summary", "Corto."], ["practice", PRACTICE], ["level", LEVEL]],
      { step: "save_course", course: COURSE, seen: 3, title: "Respirar", summary: "Corto.", practice: PRACTICE, level: LEVEL },
    ],
    [
      "guardar los datos sin práctica ni nivel",
      [["do", editorButton.saveCourse(3)], ["title", "Respirar"], ["summary", ""], ["practice", ""], ["level", ""]],
      { step: "save_course", course: COURSE, seen: 3, title: "Respirar", summary: "", practice: null, level: null },
    ],
    ["agregar un módulo", [["do", editorButton.addModule(2)], ["title", "Inicio"]], { step: "add_module", course: COURSE, seen: 2, title: "Inicio" }],
    [
      "agregar una lección",
      [["do", editorButton.addLesson(MODULE, 4)], ["title", "Una"]],
      { step: "add_lesson", course: COURSE, module: MODULE, seen: 4, title: "Una" },
    ],
    ["subir un módulo", [["do", editorButton.moduleUp(MODULE, 2)]], { step: "move_module", course: COURSE, module: MODULE, seen: 2, to: 1 }],
    ["bajar un módulo", [["do", editorButton.moduleDown(MODULE, 2)]], { step: "move_module", course: COURSE, module: MODULE, seen: 2, to: 3 }],
    [
      "subir una lección",
      [["do", editorButton.lessonUp(LESSON, MODULE, 2)]],
      { step: "move_lesson", course: COURSE, lesson: LESSON, from: { module: MODULE, position: 2 }, to: { module: MODULE, position: 1 } },
    ],
    [
      "bajar una lección",
      [["do", editorButton.lessonDown(LESSON, MODULE, 2)]],
      { step: "move_lesson", course: COURSE, lesson: LESSON, from: { module: MODULE, position: 2 }, to: { module: MODULE, position: 3 } },
    ],
    [
      "mover una lección a otro módulo",
      [["do", editorButton.lessonMove(LESSON, MODULE, 2)], ["to", moveTarget(OTHER, 5)]],
      { step: "move_lesson", course: COURSE, lesson: LESSON, from: { module: MODULE, position: 2 }, to: { module: OTHER, position: 5 } },
    ],
    ["renombrar un módulo", [["do", editorButton.saveModule(MODULE, 3)], ["title", "Cierre"]], { step: "save_module", course: COURSE, module: MODULE, seen: 3, title: "Cierre" }],
    ["preguntar antes de borrar un módulo", [["do", editorButton.askDeleteModule(MODULE)], ["title", "x"]], { step: "ask_delete", course: COURSE, title: "x", description: "" }],
    ["borrar un módulo", [["do", editorButton.deleteModule(MODULE, 3)]], { step: "delete_module", course: COURSE, module: MODULE, seen: 3 }],
    [
      "guardar una lección",
      [["do", editorButton.saveLesson(LESSON, 2)], ["title", "Una"], ["description", "Qué se hace."]],
      { step: "save_lesson", course: COURSE, lesson: LESSON, seen: 2, title: "Una", description: "Qué se hace." },
    ],
    ["borrar una lección", [["do", editorButton.deleteLesson(LESSON, 2)]], { step: "delete_lesson", course: COURSE, lesson: LESSON, seen: 2 }],
    ["cancelar", [["do", editorButton.cancel()], ["title", "Una"]], { step: "cancel", course: COURSE, title: "Una", description: "" }],
    // Arrastrar (tercera solicitud): a cualquier lugar, con lo que se vio.
    ["llevar un módulo a otro lugar", [["do", editorButton.moduleTo(MODULE, 1, 3)]], { step: "move_module", course: COURSE, module: MODULE, seen: 1, to: 3 }],
    [
      "llevar una lección a otro módulo",
      [["do", editorButton.lessonTo(LESSON, MODULE, 2, OTHER, 1)]],
      { step: "move_lesson", course: COURSE, lesson: LESSON, from: { module: MODULE, position: 2 }, to: { module: OTHER, position: 1 } },
    ],
  ] as [string, [string, string][], unknown][])("%s", (_name, entries, expected) => {
    expect(readEditorForm(form(entries))).toEqual(expected);
  });

  it.each([
    ["sin botón", []],
    ["dos botones", [["do", editorButton.cancel()], ["do", editorButton.cancel()]]],
    ["un verbo que no existe", [["do", `other:${MODULE}:2`]]],
    ["una revisión sin forma", [["do", `save-module:${MODULE}:0`], ["title", "x"]]],
    ["un id sin forma", [["do", "save-module:x:2"], ["title", "x"]]],
    ["de más", [["do", `${editorButton.saveModule(MODULE, 2)}:9`], ["title", "x"]]],
    ["una práctica sin forma", [["do", editorButton.saveCourse(3)], ["title", "R"], ["practice", "x"]]],
    ["subir el primero", [["do", editorButton.moduleUp(MODULE, 1)]]],
    ["mover sin destino", [["do", editorButton.lessonMove(LESSON, MODULE, 2)]]],
    ["mover a un destino sin forma", [["do", editorButton.lessonMove(LESSON, MODULE, 2)], ["to", "x:1"]]],
    ["llevar un módulo a su mismo lugar", [["do", editorButton.moduleTo(MODULE, 2, 2)]]],
    ["llevar un módulo al lugar cero", [["do", `module-to:${MODULE}:2:0`]]],
    ["llevar una lección a un módulo sin forma", [["do", `lesson-to:${LESSON}:${MODULE}:2:x:1`]]],
    ["llevar una lección a su mismo lugar", [["do", editorButton.lessonTo(LESSON, MODULE, 2, MODULE, 2)]]],
    ["llevar una lección con un dato de más", [["do", `${editorButton.lessonTo(LESSON, MODULE, 2, OTHER, 1)}:9`]]],
  ] as [string, [string, string][]][])("%s no es nada", (_name, entries) => {
    expect(readEditorForm(form(entries))).toEqual({ step: "none" });
  });

  it("sin un curso con forma no es nada", () => {
    const data = new FormData();
    data.append("course", "x");
    data.append("do", editorButton.cancel());
    expect(readEditorForm(data)).toEqual({ step: "none" });
    expect(readEditorForm("no es un formulario")).toEqual({ step: "none" });
  });

  it("un texto desmedido llega cortado", () => {
    const read = readEditorForm(form([["do", editorButton.saveModule(MODULE, 3)], ["title", "a".repeat(9000)]]));
    expect(read.step === "save_module" && read.title.length).toBeLessThan(9000);
  });
});
