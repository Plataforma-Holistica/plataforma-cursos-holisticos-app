import type { ChangeFailure } from "../_lib/change";
import { textField, type TextProblem } from "../_lib/text";

// Lo que llega de cada formulario del editor de curso (PA-43; T-402) y los valores de sus botones. Es
// puro, y viaja al navegador.
//
//   · Todo formulario lleva el curso en un campo oculto, y su botón dice qué se pidió con lo que se vio:
//     la revisión de lo que se cambia, o la posición (y el módulo) de lo que se mueve. Así un formulario
//     reenviado no mueve dos veces, y uno de otra pestaña contesta «cambió».
//   · De quién es el curso no lo dice el formulario: la base escribe solo a nombre del maestro activo, y
//     cada módulo y lección se busca por su id y el del curso.
//   · Un envío sin intención, con más de una o con algo sin forma cuenta como vacío.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNT = /^[1-9][0-9]{0,15}$/;
const MAX_INTENT = 200;

const isId = (value: string | undefined): value is string => value !== undefined && ID.test(value);
function countOf(value: string | undefined): number | null {
  if (value === undefined || !COUNT.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

/** Los valores de los botones. Los arma la vista y los lee `readEditorForm`. */
export const editorButton = {
  saveCourse: (revision: number) => `save-course:${revision}`,
  addModule: (structureRevision: number) => `add-module:${structureRevision}`,
  addLesson: (module: string, moduleRevision: number) => `add-lesson:${module}:${moduleRevision}`,
  moduleUp: (module: string, position: number) => `module-up:${module}:${position}`,
  moduleDown: (module: string, position: number) => `module-down:${module}:${position}`,
  lessonUp: (lesson: string, module: string, position: number) => `lesson-up:${lesson}:${module}:${position}`,
  lessonDown: (lesson: string, module: string, position: number) => `lesson-down:${lesson}:${module}:${position}`,
  lessonMove: (lesson: string, module: string, position: number) => `lesson-move:${lesson}:${module}:${position}`,
  /** Arrastrar un módulo: del lugar que se vio a cualquier otro. */
  moduleTo: (module: string, position: number, to: number) => `module-to:${module}:${position}:${to}`,
  /** Arrastrar una lección: del módulo y el lugar que se vieron a cualquier lugar de cualquier módulo. */
  lessonTo: (lesson: string, module: string, position: number, toModule: string, to: number) =>
    `lesson-to:${lesson}:${module}:${position}:${toModule}:${to}`,
  saveModule: (module: string, revision: number) => `save-module:${module}:${revision}`,
  askDeleteModule: (module: string) => `ask-delete-module:${module}`,
  deleteModule: (module: string, revision: number) => `delete-module:${module}:${revision}`,
  saveLesson: (lesson: string, revision: number) => `save-lesson:${lesson}:${revision}`,
  askDeleteLesson: (lesson: string) => `ask-delete-lesson:${lesson}`,
  deleteLesson: (lesson: string, revision: number) => `delete-lesson:${lesson}:${revision}`,
  cancel: () => "cancel",
} as const;

/** El valor de una opción de «Mover a»: el módulo de destino y el lugar después de su última lección. */
export const moveTarget = (module: string, position: number) => `${module}:${position}`;

export type EditorRequest =
  | { step: "none" }
  | { step: "cancel"; course: string; title: string; description: string }
  | { step: "ask_delete"; course: string; title: string; description: string }
  | { step: "save_course"; course: string; seen: number; title: string; summary: string; practice: string | null; level: string | null }
  | { step: "add_module"; course: string; seen: number; title: string }
  | { step: "add_lesson"; course: string; module: string; seen: number; title: string }
  | { step: "move_module"; course: string; module: string; seen: number; to: number }
  | { step: "move_lesson"; course: string; lesson: string; from: { module: string; position: number }; to: { module: string; position: number } }
  | { step: "save_module"; course: string; module: string; seen: number; title: string }
  | { step: "delete_module"; course: string; module: string; seen: number }
  | { step: "save_lesson"; course: string; lesson: string; seen: number; title: string; description: string }
  | { step: "delete_lesson"; course: string; lesson: string; seen: number };

const NONE: EditorRequest = { step: "none" };

/** Una práctica o un nivel elegidos: vacío es «ninguno»; sin forma, `undefined`. */
function choiceOf(form: FormData, name: string): string | null | undefined {
  const value = textField(form, name);
  if (value === "") return null;
  return ID.test(value) ? value : undefined;
}

export function readEditorForm(form: unknown): EditorRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return NONE;
  const course = textField(form, "course");
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (!ID.test(course) || pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return NONE;
  const parts = only.split(":");
  const [verb, a, b, c, d, e] = parts;
  const title = () => textField(form, "title");
  // Llevar una lección a otro lugar es el único botón con cinco datos.
  if (verb === "lesson-to") {
    const from = countOf(c);
    const to = countOf(e);
    if (parts.length !== 6 || !isId(a) || !isId(b) || from === null || !isId(d) || to === null) return NONE;
    if (b === d && from === to) return NONE;
    return { step: "move_lesson", course, lesson: a, from: { module: b, position: from }, to: { module: d, position: to } };
  }
  if (parts.length > 4) return NONE;

  switch (verb) {
    case "cancel":
      return a === undefined ? { step: "cancel", course, title: title(), description: textField(form, "description") } : NONE;
    case "save-course": {
      const seen = countOf(a);
      const practice = choiceOf(form, "practice");
      const level = choiceOf(form, "level");
      if (seen === null || b !== undefined || practice === undefined || level === undefined) return NONE;
      return { step: "save_course", course, seen, title: title(), summary: textField(form, "summary"), practice, level };
    }
    case "add-module": {
      const seen = countOf(a);
      return seen === null || b !== undefined ? NONE : { step: "add_module", course, seen, title: title() };
    }
    case "add-lesson": {
      const seen = countOf(b);
      return !isId(a) || seen === null || c !== undefined ? NONE : { step: "add_lesson", course, module: a, seen, title: title() };
    }
    case "module-to": {
      const seen = countOf(b);
      const to = countOf(c);
      return !isId(a) || seen === null || to === null || seen === to ? NONE : { step: "move_module", course, module: a, seen, to };
    }
    case "module-up":
    case "module-down": {
      const seen = countOf(b);
      if (!isId(a) || seen === null || c !== undefined) return NONE;
      const to = verb === "module-up" ? seen - 1 : seen + 1;
      return to < 1 ? NONE : { step: "move_module", course, module: a, seen, to };
    }
    case "lesson-up":
    case "lesson-down":
    case "lesson-move": {
      const position = countOf(c);
      if (!isId(a) || !isId(b) || position === null) return NONE;
      const from = { module: b, position };
      if (verb === "lesson-move") {
        const [module, target, ...more] = textField(form, "to").split(":");
        const to = countOf(target);
        return !isId(module) || to === null || more.length > 0 ? NONE : { step: "move_lesson", course, lesson: a, from, to: { module, position: to } };
      }
      const to = verb === "lesson-up" ? position - 1 : position + 1;
      return to < 1 ? NONE : { step: "move_lesson", course, lesson: a, from, to: { module: b, position: to } };
    }
    case "save-module":
    case "delete-module":
    case "save-lesson":
    case "delete-lesson": {
      const seen = countOf(b);
      if (!isId(a) || seen === null || c !== undefined) return NONE;
      if (verb === "save-module") return { step: "save_module", course, module: a, seen, title: title() };
      if (verb === "delete-module") return { step: "delete_module", course, module: a, seen };
      if (verb === "save-lesson") return { step: "save_lesson", course, lesson: a, seen, title: title(), description: textField(form, "description") };
      return { step: "delete_lesson", course, lesson: a, seen };
    }
    case "ask-delete-module":
    case "ask-delete-lesson":
      return isId(a) && b === undefined ? { step: "ask_delete", course, title: title(), description: textField(form, "description") } : NONE;
    default:
      return NONE;
  }
}

// ---------------------------------------------------------------------------------------
// Lo que pinta cada bloque después de un envío. `values` es lo escrito, que no se pierde.

export type Values = Readonly<Record<string, string>>;
export type Problems = Readonly<Record<string, TextProblem | "practice_inactive" | "level_inactive">>;

export type BlockState =
  | { kind: "idle" }
  /**
   * Se pidió borrar: el bloque pinta la confirmación. Trae lo escrito: React devuelve los campos del
   * formulario que envió a su valor por omisión al terminar la acción, y ese valor tiene que ser lo escrito.
   */
  | { kind: "confirming"; values: Values; attempt: number }
  /** Se canceló el borrado: vuelve lo escrito, también sin JavaScript. */
  | { kind: "kept"; values: Values; attempt: number }
  /**
   * `target` dice qué formulario contestó: `course`, `item`, `move`, `module` (agregar un módulo) o el id del
   * módulo al que se agregaba una lección. Un campo se vuelve a armar solo con la respuesta de su formulario.
   */
  | { kind: "done"; what: "saved" | "moved"; target: string; attempt: number }
  | { kind: "invalid"; problems: Problems; values: Values; target: string; attempt: number }
  /** Con `changed` no vuelve lo escrito: se pinta lo que hay ahora, para no pisar lo que cambió otra pestaña. */
  | { kind: "failed"; reason: ChangeFailure; values: Values | null; target: string; attempt: number };
