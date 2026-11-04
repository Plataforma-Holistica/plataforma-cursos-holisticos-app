import { longDate } from "@/app/_lib/dates";
import { portal } from "@/messages/es/portal";
import { plural, t } from "@/messages/format";
import { coursePath, portalCoursePath, portalDeleteCoursePath } from "@/services/account/navigation";
import type { CourseState, TeacherCourse } from "@/services/drafts/editor";
import { isEditable, isInReview, missingItems } from "@/services/drafts/field-rules";
import type { StatusTone } from "@/ui/status-badge";

// Lo que PA-42 pinta de cada curso, ya en palabras y con sus enlaces (T-402). Lo arma la página con lo
// que leyó: el navegador no decide qué se ofrece.
//
//   · Un borrador dice cuántas cosas le faltan para enviarlo (decisión de Sergio del 2026-10-29: con
//     el video de cada lección, que llega con T-403), se edita y, si nunca se envió, se borra.
//   · Al maestro suspendido se le ofrece «Ver», nunca editar ni borrar (RF-702).
//   · Uno que Contenido devolvió dice «Rechazado» y su motivo, en dos líneas, y se corrige (FL-35; T-405).
//   · Lo de un curso publicado sigue la tabla del diseño (PA-42; T-405, FL-36): publicado, «Editar» (que abre su editor en solo lectura, con
//     el botón que crea la versión) y el enlace a su ficha; con cambios pendientes, que los alumnos ven lo publicado y «Seguir editando»; la
//     versión enviada, «En revisión» y la fecha, como un curso nuevo; despublicado, «Ver». Una versión no se borra: se descarta en el editor.

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
  /** El detalle es el motivo de un rechazo: se corta en dos líneas. */
  detailIsReason: boolean;
  lessons: string | null;
  edited: string;
  action: CourseLink | null;
  remove: CourseLink | null;
  /** Su ficha pública, si está publicado. */
  publicPage: CourseLink | null;
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
  // Publicado, lo que se ve es el enlace a su ficha (diseño, PA-42).
  if (course.state === "published") return null;
  if (course.state === "changes_pending" && course.pendingVersion === "draft" && course.returned === null) return portal.stateDetail.changesPending;
  if (isEditable(course.state, course.pendingVersion)) {
    if (course.returned !== null) return course.returned.reason;
    if (course.draft === null) return null;
    // El número es el de la regla de Sergio del 2026-10-29 (`missingItems`). Si dice «Listo» lo decide además la lista de enviar (`course_readiness`), que ve reemplazos en
    // camino y pendientes: con algo de eso, no hay «Listo» aunque la regla no lo cuente.
    const counted = missingItems(course.draft);
    const missing = course.missing !== null && course.missing > 0 ? Math.max(counted, 1) : counted;
    return missing === 0 ? text.ready : t(plural(missing, text.missing), { count: missing });
  }
  if (isInReview(course.state, course.pendingVersion) && course.submittedAt !== null) return t(text.sentOn, { date: longDate(course.submittedAt) });
  const key = STATE_KEYS[isInReview(course.state, course.pendingVersion) ? "in_review" : course.state];
  // Un borrador siempre se edita, y ya contestó arriba.
  return key === "draft" ? null : portal.stateDetail[key];
}

export function courseRows(courses: readonly TeacherCourse[], readOnly: boolean): CourseRow[] {
  return courses.map((course) => {
    const editable = isEditable(course.state, course.pendingVersion) && !readOnly;
    // Un curso publicado sin versión no tiene borrador: su editor lo pinta en solo lectura, con el botón que crea la versión (T-405).
    const href = course.draft !== null || course.state === "published" || course.state === "changes_pending" || course.state === "withdrawn" ? portalCoursePath(course.id) : null;
    const opensVersion = course.state === "published" && !readOnly;
    const continues = course.state === "changes_pending" && course.pendingVersion === "draft" && course.returned === null && !readOnly;
    const publicHref = course.slug !== null && (course.state === "published" || course.state === "changes_pending") ? coursePath(course.slug) : null;
    const removeHref = editable && course.state === "draft" && course.draft !== null ? portalDeleteCoursePath(course.id) : null;
    const returned = isEditable(course.state, course.pendingVersion) && course.returned !== null;
    // Una versión enviada se dice como un curso en revisión.
    const shown: CourseState = isInReview(course.state, course.pendingVersion) ? "in_review" : course.state;
    const verb = opensVersion ? text.edit : !editable ? text.view : returned ? text.fix : continues ? text.continue : text.edit;
    const named = opensVersion ? text.editNamed : !editable ? text.viewNamed : returned ? text.fixNamed : continues ? text.continueNamed : text.editNamed;
    return {
      id: course.id,
      title: course.title,
      state: returned ? portal.states.returned : portal.states[STATE_KEYS[shown]],
      tone: returned ? "bad" : TONES[shown],
      detail: detailOf(course),
      detailIsReason: returned,
      lessons: course.lessonCount === null ? null : t(plural(course.lessonCount, text.lessons), { count: course.lessonCount }),
      edited: longDate(course.updatedAt),
      action: href === null ? null : { label: verb, href, name: t(named, { title: course.title }) },
      remove: removeHref === null ? null : { label: text.delete, href: removeHref, name: t(text.deleteNamed, { title: course.title }) },
      publicPage: publicHref === null ? null : { label: text.publicPage, href: publicHref, name: t(text.publicPageNamed, { title: course.title }) },
      cover: { title: course.title, teacherName: course.teacherName, practiceName: course.practiceName, tone: course.coverTone },
    };
  });
}
