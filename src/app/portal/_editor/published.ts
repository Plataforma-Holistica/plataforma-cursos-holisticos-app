import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import type { PublishedCourse } from "@/services/drafts/editor";
import type { StatusTone } from "@/ui/status-badge";

import { openButton } from "../_cursos/outcomes";
import { lengthText } from "./rows";

// PA-43 de un curso publicado sin versión abierta (T-405, FL-36 paso 1): lo publicado en solo lectura, ya en palabras, y el valor de «Editar».
// Sin el reproductor ni los recursos: están en la ficha del curso (decisión mía sin confirmar). «Editar» solo en un curso publicado y para un
// maestro que no está suspendido: uno retirado lo vuelve a publicar Contenido (T-406).

const text = portal.published;

export interface PublishedView {
  course: string;
  title: string;
  state: string;
  tone: StatusTone;
  intro: string;
  summary: string;
  modules: { id: string; heading: string; lessons: string[] }[];
  /** El valor de «Editar», o nulo si no se ofrece. */
  open: string | null;
}

export function publishedView(course: PublishedCourse, readOnly: boolean): PublishedView {
  const published = course.state === "published";
  return {
    course: course.id,
    title: course.title,
    state: published ? portal.states.published : portal.states.withdrawn,
    tone: published ? "good" : "bad",
    intro: published ? text.intro : portal.stateDetail.withdrawn,
    summary: course.summary ?? text.noSummary,
    modules: course.modules.map((module, index) => ({
      id: module.id,
      heading: module.title === "" ? t(text.moduleUntitled, { number: index + 1 }) : t(text.module, { number: index + 1, title: module.title }),
      lessons: module.lessons.map((lesson) => t(text.lesson, { title: lesson.title, length: lengthText(lesson.seconds) })),
    })),
    open: published && !readOnly ? openButton(course.id) : null,
  };
}
