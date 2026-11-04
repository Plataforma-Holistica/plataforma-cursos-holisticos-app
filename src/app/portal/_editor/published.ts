import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { coursePath } from "@/services/account/navigation";
import type { PublishedCourse } from "@/services/drafts/editor";
import type { StatusTone } from "@/ui/status-badge";

import { openButton } from "../_cursos/outcomes";
import { lengthText } from "./rows";

// PA-43 de un curso publicado sin versión abierta (T-405, FL-36 paso 1): lo publicado en solo lectura, ya en palabras, y el valor de «Editar».
// Sin el reproductor ni los recursos: están en su ficha, que se enlaza (decisión mía sin confirmar). Cada estado se dice por su nombre:
//
//   · Publicado: «Editar», si se puede copiar (uno cargado por guion no) y el maestro no está suspendido.
//   · Con cambios pendientes: otra pestaña abrió la versión entre leer el borrador y leer esto; «Editar» lleva a ella.
//   · Despublicado: sin «Editar» ni ficha. Volver a publicarlo es de Contenido (T-406).

const text = portal.published;

export interface PublishedView {
  course: string;
  title: string;
  state: string;
  tone: StatusTone;
  intro: string;
  /** Por qué no se puede editar desde aquí, si no se puede. */
  blocked: string | null;
  /** Su ficha pública, si está en el catálogo. */
  publicHref: string | null;
  summary: string;
  modules: { id: string; heading: string; lessons: string[] }[];
  /** El valor de «Editar», o nulo si no se ofrece. */
  open: string | null;
}

export function publishedView(course: PublishedCourse, readOnly: boolean): PublishedView {
  const withdrawn = course.state === "withdrawn";
  const pending = course.state === "changes_pending";
  const editable = !withdrawn && !readOnly && course.copyable;
  return {
    course: course.id,
    title: course.title,
    state: withdrawn ? portal.states.withdrawn : pending ? portal.states.changesPending : portal.states.published,
    tone: withdrawn ? "bad" : pending ? "active" : "good",
    intro: readOnly ? portal.editor.readOnlyDraft : withdrawn ? portal.stateDetail.withdrawn : text.intro,
    blocked: !withdrawn && !readOnly && !course.copyable ? text.notCopyable : null,
    publicHref: withdrawn ? null : coursePath(course.slug),
    summary: course.summary ?? text.noSummary,
    modules: course.modules.map((module, index) => ({
      id: module.id,
      heading: module.title === "" ? t(text.moduleUntitled, { number: index + 1 }) : t(text.module, { number: index + 1, title: module.title }),
      lessons: module.lessons.map((lesson) => t(text.lesson, { title: lesson.title, length: lengthText(lesson.seconds) })),
    })),
    open: editable ? openButton(course.id) : null,
  };
}
