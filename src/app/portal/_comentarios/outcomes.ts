import { commentAnchor, commentCursor, cursorOf } from "@/app/_comments/view";
import type { CommentView } from "@/services/comments/comments";
import { ROUTES } from "@/services/account/navigation";

// PA-45 (T-501): lo que dice la dirección (el curso, «Sin responder», la página) y las direcciones que arma la pantalla. Un curso
// que no es de los suyos no se aplica: es como sin filtro.

export interface TeacherFilters {
  course: string | null;
  unanswered: boolean;
  /** Desde dónde empieza esta página, con forma; nulo en la primera. */
  from: string | null;
}

const one = (search: Readonly<Record<string, string | string[] | undefined>>, key: string): string | null => {
  const value = search[key];
  return typeof value === "string" ? value : null;
};

export function readTeacherFilters(search: Readonly<Record<string, string | string[] | undefined>>, courses: readonly { id: string }[]): TeacherFilters {
  const course = one(search, "curso");
  return {
    course: course !== null && courses.some((each) => each.id === course) ? course : null,
    unanswered: one(search, "sin-responder") === "1",
    from: commentCursor(one(search, "desde")),
  };
}

/** La dirección de PA-45 con esos filtros, y desde una página si se pide. */
export function teacherCommentsHref(filters: { course: string | null; unanswered: boolean }, from: string | null = null): string {
  const query = [
    filters.course === null ? null : `curso=${filters.course}`,
    filters.unanswered ? "sin-responder=1" : null,
    from === null ? null : `desde=${encodeURIComponent(from)}`,
  ].filter(Boolean);
  return query.length === 0 ? ROUTES.portalComments : `${ROUTES.portalComments}?${query.join("&")}`;
}

/** Las respuestas siguientes de un comentario, en PA-45 y sin perder los filtros ni la página: reemplazan las suyas. */
export const teacherRepliesHref = (filters: TeacherFilters, parentId: string, last: Pick<CommentView, "createdAt" | "id">) => {
  const base = teacherCommentsHref(filters, filters.from);
  return `${base}${base.includes("?") ? "&" : "?"}hilo=${parentId}&respuestas=${encodeURIComponent(cursorOf(last))}#${commentAnchor(parentId)}`;
};

/** Las primeras respuestas otra vez: la misma página, sin el hilo. */
export const teacherFirstRepliesHref = (filters: TeacherFilters, parentId: string) => `${teacherCommentsHref(filters, filters.from)}#${commentAnchor(parentId)}`;
