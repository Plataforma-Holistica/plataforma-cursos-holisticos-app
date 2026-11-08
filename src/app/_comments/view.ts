import type { CommentThread, CommentView, WriteStanding } from "@/services/comments/comments";

// Lo que la pantalla necesita para pintar los comentarios de una lección (PA-22; T-501), y lo puro de cómo se pintan: el
// avatar y las direcciones de las páginas. Lo arma la página con lo que contestó el servicio.

export interface CommentsView {
  /** Lo publicado que todos ven, para el título y la pestaña. */
  count: number;
  items: CommentThread[];
  /** Desde dónde sigue la página siguiente; nulo si no hay más. */
  next: string | null;
  /** Si esta no es la primera página. */
  paged: boolean;
  /** El hilo cuyas respuestas no son las primeras. */
  pagedThread: string | null;
  me: { teacher: boolean; pseudonym: string | null };
  write: WriteStanding;
}

/** El lugar de los comentarios en la lección: el ancla de la pestaña y de cada página. */
export const COMMENTS_ANCHOR = "comentarios";
export const commentAnchor = (id: string) => `comentario-${id}`;

/** Por dónde sigue una página: el último que se vio, como viaja en la dirección. */
export const cursorOf = (comment: Pick<CommentView, "createdAt" | "id">) => `${comment.createdAt}_${comment.id}`;

export const moreCommentsHref = (back: string, next: string) => `${back}?comentarios=${encodeURIComponent(next)}#${COMMENTS_ANCHOR}`;
export const newestCommentsHref = (back: string) => `${back}#${COMMENTS_ANCHOR}`;
export const moreRepliesHref = (back: string, parentId: string, last: CommentView) =>
  `${back}?hilo=${parentId}&respuestas=${encodeURIComponent(cursorOf(last))}#${commentAnchor(parentId)}`;
export const firstRepliesHref = (back: string, parentId: string) => `${back}#${commentAnchor(parentId)}`;

const TONES = 8;

/**
 * El avatar de un nombre: su inicial sobre uno de los ocho tonos de portada (diseño §5.12; sin fotos en el MVP, D-17). El tono
 * sale del nombre, para que la misma persona lleve siempre el mismo.
 */
export function avatarOf(name: string): { initial: string; tone: number } {
  const first = [...name.trim()][0];
  let hash = 0;
  for (const point of name) hash = (hash * 31 + (point.codePointAt(0) ?? 0)) % 1_000_003;
  return { initial: first === undefined ? "?" : first.toLocaleUpperCase("es-MX"), tone: (hash % TONES) + 1 };
}
