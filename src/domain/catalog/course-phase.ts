// En qué fase está un curso (T-405, versiones): qué se edita y qué se revisa. Una versión de un curso publicado vive como `changes_pending`, con la
// versión en borrador o en revisión, nunca como `in_review`. Es la regla de `private.course_editable` y `private.course_reviewing` en la base, que es
// la que manda: aquí solo decide qué ofrece una pantalla.

export const COURSE_STATES = ["draft", "in_review", "published", "changes_pending", "withdrawn"] as const;
export type CourseState = (typeof COURSE_STATES)[number];

/** El estado de la versión pendiente de un curso publicado, o nulo si no tiene. */
export const PENDING_VERSIONS = ["draft", "in_review"] as const;
export type PendingVersion = (typeof PENDING_VERSIONS)[number];

/** Se edita: un borrador nuevo, o la versión en borrador de un curso publicado. */
export const isEditable = (state: CourseState, pending: PendingVersion | null): boolean =>
  state === "draft" || (state === "changes_pending" && pending === "draft");

/** Se revisa: un curso nuevo enviado, o la versión enviada de un curso publicado. */
export const isInReview = (state: CourseState, pending: PendingVersion | null): boolean =>
  state === "in_review" || (state === "changes_pending" && pending === "in_review");
