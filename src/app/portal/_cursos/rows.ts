import { longDate } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { plural, t } from "@/messages/format";
import { portalCoursePath, portalDeleteCoursePath } from "@/services/account/navigation";
import type { CourseState, TeacherCourse } from "@/services/drafts/editor";
import { missingItems } from "@/services/drafts/field-rules";
import type { StatusTone } from "@/ui/status-badge";

// Lo que PA-42 pinta de cada curso, ya en palabras y con sus enlaces (T-402). Lo arma la página con lo
// que leyó: el navegador no decide qué se ofrece.
//
//   · Un borrador dice cuántas cosas le faltan para enviarlo (decisión de Sergio del 2026-10-29: con
//     el video de cada lección, que llega con T-403), se edita y, si nunca se envió, se borra.
//   · Al maestro suspendido se le ofrece «Ver», nunca editar ni borrar (RF-702).
//   · Un curso sin borrador (los cargados por guion) no se abre en el editor hasta T-405.

const text = portal.courses;

export interface CourseLink {
  label: string;
  href: string;
  /** El nombre accesible: el verbo y el curso, para que la lista de enlaces se entienda sola. */
  name: string;
}

export interface CourseRow {
  id: string;
  title: string;
  state: string;
  tone: StatusTone;
  detail: string | null;
  lessons: string | null;
  edited: string;
  action: CourseLink | null;
  remove: CourseLink | null;
  cover: { title: string; teacherName: string | null; practiceName: string | null; tone: number | null };
}

/** La clave de cada estado en el catálogo de textos, que va en camelCase. */
const STATE_KEYS = {
  draft: "draft",
  in_review: "inReview",
  published: "published",
  changes_pending: "changesPending",
  withdrawn: "withdrawn",
} as const satisfies Record<CourseState, string>;

const TONES: Record<CourseState, StatusTone> = {
  draft: "neutral",
  in_review: "attention",
  published: "good",
  changes_pending: "active",
  withdrawn: "bad",
};

function detailOf(course: TeacherCourse): string | null {
  if (course.state === "draft") {
    if (course.draft === null) return null;
    const missing = missingItems(course.draft);
    return missing === 0 ? text.ready : t(plural(missing, text.missing), { count: missing });
  }
  return portal.stateDetail[STATE_KEYS[course.state]];
}

export function courseRows(courses: readonly TeacherCourse[], readOnly: boolean): CourseRow[] {
  return courses.map((course) => {
    const editable = course.state === "draft" && !readOnly;
    const href = course.draft !== null ? portalCoursePath(course.id) : null;
    const removeHref = editable && course.draft !== null ? portalDeleteCoursePath(course.id) : null;
    const verb = editable ? text.edit : text.view;
    return {
      id: course.id,
      title: course.title,
      state: portal.states[STATE_KEYS[course.state]],
      tone: TONES[course.state],
      detail: detailOf(course),
      lessons: course.draft === null ? null : t(plural(course.draft.lessons, text.lessons), { count: course.draft.lessons }),
      edited: longDate(course.updatedAt),
      action: href === null ? null : { label: verb, href, name: t(editable ? text.editNamed : text.viewNamed, { title: course.title }) },
      remove: removeHref === null ? null : { label: text.delete, href: removeHref, name: t(text.deleteNamed, { title: course.title }) },
      cover: { title: course.title, teacherName: course.teacherName, practiceName: course.practiceName, tone: course.coverTone },
    };
  });
}
