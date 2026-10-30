import { clockTime, longDate, PRODUCT_TIME_ZONE, productDay } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { portalCoursePath, ROUTES } from "@/services/account/navigation";
import type { CourseState, DraftChoices, DraftCourse } from "@/services/drafts/editor";
import type { StatusTone } from "@/ui/status-badge";

import { editorButton, moveTarget } from "./outcomes";

// Lo que el editor de curso pinta (PA-43; T-402), ya en palabras y con los valores de sus botones. Lo arma
// la página con lo que leyó: el navegador no decide qué se ofrece.
//
//   · La primera fila no sube y la última no baja: la base contestaría que no se puede.
//   · «Mover a» ofrece los otros módulos, al lugar después de su última lección.
//   · Lo elegido (`?modulo=` o `?leccion=`) vale solo si es de este curso; si no, los datos del curso.
//   · Si la práctica o el nivel elegidos se desactivaron, siguen elegidos y marcados: así guardar otro
//     campo no los quita (el borrador los conserva hasta que su maestro elija otros).
//   · La hora del guardado va en la zona del producto, con la fecha si no es de hoy (decisión mía sin
//     confirmar).

const text = portal.editor;

export interface Option {
  value: string;
  label: string;
}

export interface LessonRow {
  id: string;
  title: string;
  href: string;
  current: boolean;
  up: string | null;
  down: string | null;
  /** Nulo si no hay otro módulo a donde moverla. */
  move: string | null;
  targets: Option[];
}

export interface ModuleRow {
  id: string;
  title: string;
  label: string;
  href: string;
  current: boolean;
  up: string | null;
  down: string | null;
  addLesson: string;
  lessons: LessonRow[];
}

export type Selected =
  | { kind: "course" }
  | { kind: "module"; id: string; title: string; lessons: number; save: string; askDelete: string; remove: string }
  | { kind: "lesson"; id: string; title: string; description: string | null; save: string; askDelete: string; remove: string };

export interface EditorView {
  course: string;
  title: string;
  state: string;
  tone: StatusTone;
  saved: string;
  /** Se ofrecen los formularios: un borrador, y un maestro que no está suspendido. */
  editable: boolean;
  /** Por qué no se edita, si el curso ya no es un borrador. */
  notice: string | null;
  paths: { base: string; self: string };
  data: {
    title: string;
    summary: string;
    practice: string;
    level: string;
    practices: Option[];
    levels: Option[];
    inactive: boolean;
    cover: { title: string; teacherName: string; practiceName: string | null; tone: number | null };
    save: string;
  };
  structure: { addModule: string; modules: ModuleRow[] };
  selected: Selected;
}

const STATE_KEYS = {
  draft: "draft",
  in_review: "inReview",
  published: "published",
  changes_pending: "changesPending",
  withdrawn: "withdrawn",
} as const satisfies Record<CourseState, string>;

const TONES: Record<CourseState, StatusTone> = { draft: "neutral", in_review: "attention", published: "good", changes_pending: "active", withdrawn: "bad" };

/** Un valor de la consulta, si llegó uno solo. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function savedLabel(updatedAt: string, now: Date): string {
  const time = clockTime(updatedAt, PRODUCT_TIME_ZONE);
  const sameDay = productDay(new Date(updatedAt)) === productDay(now);
  return sameDay ? t(text.savedAt, { time }) : t(text.savedOn, { date: longDate(updatedAt), time });
}

function options(list: readonly { id: string; name: string; active: boolean }[], inactive: typeof text.inactivePractice | typeof text.inactiveLevel): Option[] {
  return list.map((item) => ({ value: item.id, label: item.active ? item.name : t(inactive, { name: item.name }) }));
}

export function editorView(
  draft: DraftCourse,
  choices: DraftChoices,
  context: { readOnly: boolean; search: Readonly<Record<string, string | string[] | undefined>>; now: Date },
): EditorView {
  const base = portalCoursePath(draft.id) ?? ROUTES.portalCourses;
  const link = (selection: { module?: string; lesson?: string }) => portalCoursePath(draft.id, selection) ?? base;
  const wantedModule = single(context.search.modulo);
  const wantedLesson = single(context.search.leccion);

  const allLessons = draft.modules.flatMap((module) => module.lessons.map((lesson) => ({ module, lesson })));
  const lessonHit = allLessons.find(({ lesson }) => lesson.id === wantedLesson);
  const moduleHit = lessonHit === undefined ? draft.modules.find((module) => module.id === wantedModule) : undefined;

  let selected: Selected = { kind: "course" };
  let self = base;
  if (lessonHit !== undefined) {
    const { lesson } = lessonHit;
    selected = {
      kind: "lesson",
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      save: editorButton.saveLesson(lesson.id, lesson.revision),
      askDelete: editorButton.askDeleteLesson(lesson.id),
      remove: editorButton.deleteLesson(lesson.id, lesson.revision),
    };
    self = link({ lesson: lesson.id });
  } else if (moduleHit !== undefined) {
    selected = {
      kind: "module",
      id: moduleHit.id,
      title: moduleHit.title,
      lessons: moduleHit.lessons.length,
      save: editorButton.saveModule(moduleHit.id, moduleHit.revision),
      askDelete: editorButton.askDeleteModule(moduleHit.id),
      remove: editorButton.deleteModule(moduleHit.id, moduleHit.revision),
    };
    self = link({ module: moduleHit.id });
  }

  const practice = choices.practices.find((item) => item.id === draft.practiceId) ?? null;
  const level = choices.levels.find((item) => item.id === draft.levelId) ?? null;
  const lastModule = draft.modules.length;

  const modules: ModuleRow[] = draft.modules.map((module, index) => {
    const targets = draft.modules
      .filter((other) => other.id !== module.id)
      .map((other) => ({ value: moveTarget(other.id, other.lessons.length + 1), label: other.title }));
    return {
      id: module.id,
      title: module.title,
      label: t(text.module, { number: index + 1 }),
      href: link({ module: module.id }),
      current: selected.kind === "module" && selected.id === module.id,
      up: module.position > 1 ? editorButton.moduleUp(module.id, module.position) : null,
      down: module.position < lastModule ? editorButton.moduleDown(module.id, module.position) : null,
      addLesson: editorButton.addLesson(module.id, module.revision),
      lessons: module.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        href: link({ lesson: lesson.id }),
        current: selected.kind === "lesson" && selected.id === lesson.id,
        up: lesson.position > 1 ? editorButton.lessonUp(lesson.id, module.id, lesson.position) : null,
        down: lesson.position < module.lessons.length ? editorButton.lessonDown(lesson.id, module.id, lesson.position) : null,
        move: targets.length > 0 ? editorButton.lessonMove(lesson.id, module.id, lesson.position) : null,
        targets,
      })),
    };
  });

  const key = STATE_KEYS[draft.state];
  return {
    course: draft.id,
    title: draft.title,
    state: portal.states[key],
    tone: TONES[draft.state],
    saved: savedLabel(draft.updatedAt, context.now),
    editable: draft.state === "draft" && !context.readOnly,
    notice: key === "draft" ? null : portal.stateDetail[key],
    paths: { base, self },
    data: {
      title: draft.title,
      summary: draft.summary ?? "",
      practice: draft.practiceId ?? "",
      level: draft.levelId ?? "",
      practices: options(choices.practices, text.inactivePractice),
      levels: options(choices.levels, text.inactiveLevel),
      inactive: practice?.active === false || level?.active === false,
      cover: { title: draft.title, teacherName: draft.teacherName ?? "", practiceName: practice?.name ?? null, tone: practice?.tone ?? null },
      save: editorButton.saveCourse(draft.revision),
    },
    structure: { addModule: editorButton.addModule(draft.structureRevision), modules },
    selected,
  };
}
