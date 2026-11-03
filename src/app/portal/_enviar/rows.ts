import { longDate } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { plural, t } from "@/messages/format";
import { portalAnnexPath, portalCoursePath, ROUTES } from "@/services/account/navigation";
import type { DraftChoices, DraftCourse, MissingLine, SubmitPreview } from "@/services/drafts/editor";

import { lengthText } from "../_editor/rows";
import { removePendingButton, submitButton } from "./outcomes";

// Lo que PA-44 pinta, ya en palabras y con los valores de sus botones (FL-34, pasos 2 y 3). Lo arma la página con lo que leyó: el navegador no decide qué se ofrece. Lo que falta
// sale de la base (`course_readiness`), la misma lista que enviar comprueba; los avisos de duración, del borrador, con `TOLERANCIA_LECCION`.

const text = portal.submit;

export interface MissingRow {
  text: string;
  /** A dónde ir a corregirlo, en el editor. */
  href: string | null;
  /** Un recurso a medio subir: se quita desde aquí, porque el editor no lista los pendientes. */
  remove: string | null;
}

export interface SubmitView {
  course: string;
  title: string;
  back: string;
  self: string;
  /** Lo hecho, si no falta nada. */
  done: string[];
  missing: MissingRow[];
  warnings: string[];
  /** El anexo y lo que se acepta, solo si no falta nada. */
  annex: { meta: string; draft: boolean; title: string; body: string; href: string; statement: string; button: string } | null;
  /** Por qué no se puede enviar, si no es por algo que falte. Con esto no se pintan los pasos. */
  blocked: string | null;
  /** El título de cada lección, para decir cuál tiene un video que su proveedor ya no tiene. */
  lessonTitles: Record<string, string>;
}

function missingText(line: MissingLine): string {
  const title = line.title ?? "";
  switch (line.what) {
    case "summary":
      return text.missing.summary;
    case "practice":
      return text.missing.practice;
    case "level":
      return text.missing.level;
    case "modules":
      return text.missing.modules;
    case "module_empty":
      return t(text.missing.moduleEmpty, { title });
    case "lesson_no_video":
      return t(text.missing.lessonNoVideo, { title });
    case "video_in_progress":
      return t(text.missing.videoInProgress, { title });
    case "video_errored":
      return t(text.missing.videoErrored, { title });
    case "resource_pending":
      return t(text.missing.resourcePending, { title });
  }
}

function missingHref(course: string, line: MissingLine): string | null {
  if (line.what === "resource_pending") return null;
  if (line.lesson !== null) return portalCoursePath(course, { lesson: line.lesson });
  if (line.module !== null) return portalCoursePath(course, { module: line.module });
  return portalCoursePath(course);
}

/** Las lecciones fuera de tolerancia, con su duración: no impiden enviar, la revisión decide. */
function warningsOf(draft: DraftCourse, tolerance: DraftChoices["lessonTolerance"]): string[] {
  if (tolerance === null) return [];
  const titles = new Map(draft.modules.flatMap((module) => module.lessons.map((lesson) => [lesson.id, lesson.title] as const)));
  return draft.videos
    .filter((video) => video.isCurrent && video.seconds !== null && (video.seconds < tolerance.minSeconds || video.seconds > tolerance.maxSeconds))
    .map((video) =>
      t(text.warning, {
        title: titles.get(video.lessonId) ?? "",
        duration: lengthText(video.seconds),
        min: Math.round(tolerance.minSeconds / 60),
        max: Math.round(tolerance.maxSeconds / 60),
      }),
    );
}

export function submitView(preview: SubmitPreview, draft: DraftCourse, tolerance: DraftChoices["lessonTolerance"]): SubmitView {
  const course = draft.id;
  const back = portalCoursePath(course) ?? ROUTES.portalCourses;
  const self = `${back}/enviar`;
  const lessons = draft.modules.reduce((sum, module) => sum + module.lessons.length, 0);
  const lessonTitles = Object.fromEntries(draft.modules.flatMap((module) => module.lessons.map((lesson) => [lesson.id, lesson.title])));
  const base = { course, title: draft.title, back, self, warnings: warningsOf(draft, tolerance), lessonTitles };

  if (preview.kind === "not_ready") {
    return {
      ...base,
      done: [],
      missing: preview.missing.map((line) => ({
        text: missingText(line),
        href: missingHref(course, line),
        remove: line.what === "resource_pending" && line.resource !== null && line.revision !== null ? removePendingButton(course, line.resource, line.revision) : null,
      })),
      annex: null,
      blocked: null,
    };
  }
  if (preview.kind !== "ready") {
    const blocked = preview.kind === "annex_missing" ? text.annexMissing : preview.kind === "not_editable" ? text.notEditable : text.cannotSubmit;
    return { ...base, done: [], missing: [], annex: null, blocked };
  }
  return {
    ...base,
    done: [
      text.done.data,
      `${t(plural(draft.modules.length, text.done.modules), { count: draft.modules.length })}, ${t(plural(lessons, text.done.lessons), { count: lessons })}`,
      t(text.done.videos, { count: lessons }),
    ],
    missing: [],
    annex: {
      meta: t(text.annexMeta, { version: preview.annex.version, date: longDate(preview.annex.effectiveFrom) }),
      draft: preview.annex.version === 0,
      title: preview.annex.title,
      body: preview.annex.body,
      href: portalAnnexPath(preview.annex.id) ?? ROUTES.portalAccount,
      statement: preview.statement,
      button: submitButton({ course, annex: preview.annex.id, seen: preview.contentSha256, term: preview.termYears, submission: preview.submissionNo }),
    },
    blocked: null,
  };
}
