import type { ChangeFailure } from "../_lib/change";
import { textField } from "../_lib/text";

// Los recursos en el editor de curso (PA-43; T-404): lo que llega de la lista, los valores de sus botones y qué se
// le dice a la persona. Es puro, y viaja al navegador. Como en el resto del editor, de quién es el curso no lo dice
// el formulario: la base escribe solo a nombre del maestro activo y busca cada recurso por su id y el del curso.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNT = /^[1-9][0-9]{0,15}$/;
const POSITION = /^[1-9][0-9]{0,5}$/;
const MAX_INTENT = 200;
const TITLE_MAX = 120;

const isId = (value: string | undefined): value is string => value !== undefined && ID.test(value);
function numberOf(pattern: RegExp, value: string | undefined): number | null {
  if (value === undefined || !pattern.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Los valores de los botones de la lista. Los arma la vista y los lee `readResourceForm`. */
export const resourceButton = {
  up: (resource: string, position: number) => `resource-move:${resource}:${position}:${position - 1}`,
  down: (resource: string, position: number) => `resource-move:${resource}:${position}:${position + 1}`,
  ask: (resource: string) => `resource-ask:${resource}`,
  remove: (resource: string, revision: number) => `resource-remove:${resource}:${revision}`,
  cancel: () => "cancel",
} as const;

export type ResourceRequest =
  | { step: "none" }
  | { step: "cancel"; course: string; lesson: string | null }
  | { step: "ask"; course: string; lesson: string | null; resource: string }
  | { step: "move"; course: string; lesson: string | null; resource: string; seen: number; to: number }
  | { step: "remove"; course: string; lesson: string | null; resource: string; seen: number };

const NONE: ResourceRequest = { step: "none" };

export function readResourceForm(form: unknown): ResourceRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return NONE;
  const course = textField(form, "course");
  const lessonField = textField(form, "lesson");
  const lesson = lessonField === "" ? null : lessonField;
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (!ID.test(course) || (lesson !== null && !ID.test(lesson))) return NONE;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return NONE;
  const [verb, a, b, c, ...more] = only.split(":");
  if (more.length > 0) return NONE;
  switch (verb) {
    case "cancel":
      return a === undefined ? { step: "cancel", course, lesson } : NONE;
    case "resource-ask":
      return isId(a) && b === undefined ? { step: "ask", course, lesson, resource: a } : NONE;
    case "resource-remove": {
      const seen = numberOf(COUNT, b);
      return isId(a) && seen !== null && c === undefined ? { step: "remove", course, lesson, resource: a, seen } : NONE;
    }
    case "resource-move": {
      const seen = numberOf(POSITION, b);
      const to = numberOf(POSITION, c);
      return isId(a) && seen !== null && to !== null && seen !== to ? { step: "move", course, lesson, resource: a, seen, to } : NONE;
    }
    default:
      return NONE;
  }
}

export type ResourceState =
  | { kind: "idle" }
  /** Se pidió quitar: la fila pinta la confirmación. */
  | { kind: "confirming"; resource: string; attempt: number }
  | { kind: "kept"; attempt: number }
  | { kind: "done"; what: "moved" | "removed"; attempt: number }
  | { kind: "failed"; reason: ChangeFailure; attempt: number };

/** Por qué no se pudo adjuntar un archivo. Cada una tiene su texto en el catálogo. */
export type UploadProblem =
  | "fileType"
  | "fileSize"
  | "noFile"
  | "tooMany"
  | "throttled"
  | "rejectedType"
  | "rejectedSize"
  | "rejectedContent"
  | "expired"
  | "notUploaded"
  | "gone"
  | "unavailable";

/** Lo que contesta empezar a subir. */
export type BeginStep = { kind: "go"; resource: string; url: string; mime: string } | { kind: "problem"; problem: UploadProblem };
/** Lo que contesta confirmar. */
export type ConfirmStep = { kind: "ready" } | { kind: "problem"; problem: UploadProblem };

/**
 * Lo que se revisa antes de subir, para no gastar la subida. Es comodidad, no control: lo que manda es la base y
 * la cubeta. `allowed` es si el nombre es de un tipo que se admite.
 */
export function checkFile(file: { size: number }, allowed: boolean, maxBytes: number | null): UploadProblem | null {
  if (!allowed) return "fileType";
  if (file.size < 1 || (maxBytes !== null && file.size > maxBytes)) return "fileSize";
  return null;
}

/** El título por omisión: el nombre del archivo sin su extensión, en lo que cabe. */
export function titleFromFile(name: string): string {
  return name
    .replace(/[\p{C}]/gu, "")
    .replace(/\.[^.]+$/, "")
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
}

/** Para quien lee en voz alta: el avance se anuncia cada 25 %. */
export const progressStep = (loaded: number, total: number): number => (total > 0 ? Math.floor((Math.min(loaded, total) / total) * 4) * 25 : 0);
