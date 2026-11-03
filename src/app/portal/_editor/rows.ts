import { resourceDetail, sizeText } from "@/app/_catalog/resources/words";
import { clockTime, longDate, PRODUCT_TIME_ZONE, productDay } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { portalCoursePath, ROUTES, portalSubmitPath } from "@/services/account/navigation";
import type { CourseState, DraftChoices, DraftCourse, DraftVideo } from "@/services/drafts/editor";
import type { StatusTone } from "@/ui/status-badge";

import { editorButton, moveTarget } from "./outcomes";
import { resourceButton } from "./resource-outcomes";

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
  /** Su número en el curso («1.2»): quien ve dice «la 1.2», y el lector de pantalla lo lee junto al título. */
  number: string;
  href: string;
  current: boolean;
  up: string | null;
  down: string | null;
  /** Nulo si no hay otro módulo a donde moverla. */
  move: string | null;
  targets: Option[];
}

/** Un recurso de la lista: lo que se ve y los valores de sus botones. */
export interface ResourceRow {
  id: string;
  title: string;
  /** «PDF, 2 MB». */
  detail: string;
  revision: number;
  up: string | null;
  down: string | null;
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

/** El video de una lección: lo que está en camino, y si no, el vigente. */
export interface VideoRow {
  id: string;
  state: DraftVideo["state"];
  fileName: string;
  size: string;
  /** Lo que dura, si ya se midió. */
  duration: string;
  /** El día en que se borra si sigue así: solo lo que todavía no está listo. */
  deletesOn: string | null;
  /** Cuánto falta para decir que está tardando, o nulo si no se está procesando. Creándose no: cada reintento renueva el reclamo, y el aviso aparecería y se iría. */
  slowInMs: number | null;
  /** Por qué falló, si se sabe y le sirve a quien lo subió. */
  tooLong: boolean;
  /** La vigente, que es la que se puede ver: la lección sigue con ella mientras la nueva no esté lista. */
  currentId: string | null;
  /** La vigente, mientras otro la va a reemplazar. */
  replacing: { fileName: string; duration: string } | null;
  /** El aviso de duración de la vigente, que no bloquea. */
  tolerance: string | null;
}

export type Selected =
  | { kind: "course" }
  | { kind: "module"; id: string; title: string; place: string; lessons: number; save: string; askDelete: string; remove: string }
  | { kind: "lesson"; id: string; title: string; place: string; description: string | null; save: string; askDelete: string; remove: string; resources: ResourceRow[]; video: VideoRow | null };

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
  /** PA-44, si se puede enviar desde aquí. */
  submitHref: string | null;
  /** Si Contenido lo devolvió: arriba de todo (FL-35, paso 3). */
  returned: { title: string; reason: string; whatToFix: string } | null;
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
    resources: ResourceRow[];
  };
  resourceLimits: { maxBytes: number | null; maxText: string; perPlace: number | null };
  videoLimits: { maxBytes: number | null; maxText: string };
  /** Cada cuánto preguntar por los videos, o nulo si ninguno está en camino. */
  checkVideosEvery: number | null;
  lessonIds: string[];
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

/** Los recursos de un lugar (una lección, o nulo: el curso), en orden. El primero no sube y el último no baja. */
function resourceRows(draft: DraftCourse, lesson: string | null): ResourceRow[] {
  const here = draft.resources.filter((resource) => resource.lessonId === lesson).sort((a, b) => a.position - b.position);
  return here.map((resource, index) => ({
    id: resource.id,
    title: resource.title,
    detail: resourceDetail(resource.kind, resource.sizeBytes),
    revision: resource.revision,
    up: index > 0 ? resourceButton.up(resource.id, resource.position) : null,
    down: index < here.length - 1 ? resourceButton.down(resource.id, resource.position) : null,
  }));
}

function options(list: readonly { id: string; name: string; active: boolean }[], inactive: typeof text.inactivePractice | typeof text.inactiveLevel): Option[] {
  return list.map((item) => ({ value: item.id, label: item.active ? item.name : t(inactive, { name: item.name }) }));
}

/** Procesar suele tomar minutos. Pasado esto se dice que está tardando (decisión mía sin confirmar). */
const SLOW_AFTER_MS = 60 * 60 * 1_000;

/** Lo que el proveedor está haciendo se pregunta seguido; que lleguen los subtítulos, o que se libere un tope, puede tardar. */
function checkVideosEvery(videos: readonly DraftVideo[]): number | null {
  if (videos.some((video) => video.state === "creating" || video.state === "processing")) return 15;
  return videos.some((video) => video.state === "uploaded" || (video.state === "ready" && !video.captionsReady)) ? 60 : null;
}

/** «1 h 20 min», «20 min 34 s». También lo usa PA-44. */
export function lengthText(seconds: number | null): string {
  if (seconds === null) return "";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return t(text.videos.length.hours, { hours, minutes });
  return minutes > 0 ? t(text.videos.length.minutes, { minutes, seconds: rest }) : t(text.videos.length.seconds, { seconds: rest });
}

function videoRow(draft: DraftCourse, lesson: string, tolerance: DraftChoices["lessonTolerance"], now: Date): VideoRow | null {
  const here = draft.videos.filter((video) => video.lessonId === lesson);
  const current = here.find((video) => video.isCurrent);
  const shown = here.find((video) => !video.isCurrent) ?? current;
  if (shown === undefined) return null;
  const claimed = shown.state === "processing" && shown.claimedAt !== null ? new Date(shown.claimedAt).getTime() : null;
  const outside =
    current?.seconds !== null && current?.seconds !== undefined && tolerance !== null && (current.seconds < tolerance.minSeconds || current.seconds > tolerance.maxSeconds);
  return {
    id: shown.id,
    state: shown.state,
    fileName: shown.fileName,
    size: sizeText(shown.sizeBytes),
    duration: lengthText(shown.seconds),
    deletesOn: shown.deletesAt === null ? null : longDate(shown.deletesAt),
    slowInMs: claimed === null ? null : Math.max(0, claimed + SLOW_AFTER_MS - now.getTime()),
    tooLong: shown.errorCode === "too_long",
    currentId: current?.id ?? null,
    replacing: current === undefined || current === shown ? null : { fileName: current.fileName, duration: lengthText(current.seconds) },
    tolerance: outside
      ? t(text.videos.tolerance, { duration: lengthText(current.seconds), min: Math.round(tolerance.minSeconds / 60), max: Math.round(tolerance.maxSeconds / 60) })
      : null,
  };
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
  const moduleLabel = (id: string) => t(text.module, { number: draft.modules.findIndex((module) => module.id === id) + 1 });
  if (lessonHit !== undefined) {
    const { lesson, module } = lessonHit;
    selected = {
      kind: "lesson",
      id: lesson.id,
      title: lesson.title,
      place: t(text.lessonPlace, { module: moduleLabel(module.id), number: module.lessons.indexOf(lesson) + 1 }),
      description: lesson.description,
      save: editorButton.saveLesson(lesson.id, lesson.revision),
      askDelete: editorButton.askDeleteLesson(lesson.id),
      remove: editorButton.deleteLesson(lesson.id, lesson.revision),
      resources: resourceRows(draft, lesson.id),
      video: videoRow(draft, lesson.id, choices.lessonTolerance, context.now),
    };
    self = link({ lesson: lesson.id });
  } else if (moduleHit !== undefined) {
    selected = {
      kind: "module",
      id: moduleHit.id,
      title: moduleHit.title,
      place: moduleLabel(moduleHit.id),
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
      lessons: module.lessons.map((lesson, place) => ({
        id: lesson.id,
        title: lesson.title,
        number: t(text.lessonNumber, { module: index + 1, lesson: place + 1 }),
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
    submitHref: draft.state === "draft" && !context.readOnly ? portalSubmitPath(draft.id) : null,
    returned:
      draft.returned === null
        ? null
        : { title: t(text.returned.title, { date: longDate(draft.returned.returnedAt) }), reason: draft.returned.reason, whatToFix: draft.returned.whatToFix },
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
      resources: resourceRows(draft, null),
    },
    resourceLimits: {
      maxBytes: choices.resourceLimits.maxBytes,
      maxText: choices.resourceLimits.maxBytes === null ? "" : sizeText(choices.resourceLimits.maxBytes),
      perPlace: choices.resourceLimits.perPlace,
    },
    videoLimits: {
      maxBytes: choices.videoMaxBytes,
      maxText: choices.videoMaxBytes === null ? "" : sizeText(choices.videoMaxBytes),
    },
    checkVideosEvery: checkVideosEvery(draft.videos),
    lessonIds: draft.modules.flatMap((module) => module.lessons.map((lesson) => lesson.id)),
    structure: { addModule: editorButton.addModule(draft.structureRevision), modules },
    selected,
  };
}
