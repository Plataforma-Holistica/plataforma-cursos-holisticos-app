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
  /** Desde dónde empieza esta página, como vino en la dirección; nulo en la primera. */
  cursor: string | null;
  /** La dirección de lo que se está viendo, sin el ancla: a ella vuelve un envío sin JavaScript. */
  here: string;
  /** El hilo cuyas respuestas no son las primeras. */
  pagedThread: string | null;
  me: { teacher: boolean; pseudonym: string | null };
  write: WriteStanding;
}

/** El lugar de los comentarios en la lección: el ancla de la pestaña y de cada página. */
export const COMMENTS_ANCHOR = "comentarios";
export const commentAnchor = (id: string) => `comentario-${id}`;

/**
 * El cursor de la dirección, si tiene forma (`<instante>_<id>`); si no, nulo. El servicio lo valida de verdad (un día que exista);
 * esto es para que la pantalla no crea que está en otra página cuando el servicio empezó por lo más reciente.
 */
export function commentCursor(text: string | null): string | null {
  if (text === null || text.length > 80) return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text) ? text : null;
}

/** Por dónde sigue una página: el último que se vio, como viaja en la dirección. */
export const cursorOf = (comment: Pick<CommentView, "createdAt" | "id">) => `${comment.createdAt}_${comment.id}`;

export const moreCommentsHref = (back: string, next: string) => `${back}?comentarios=${encodeURIComponent(next)}#${COMMENTS_ANCHOR}`;
export const newestCommentsHref = (back: string) => `${back}#${COMMENTS_ANCHOR}`;
/** La página de comentarios en la que se está, para que las respuestas de un hilo no la pierdan. */
const pageQuery = (cursor: string | null) => (cursor === null ? "" : `comentarios=${encodeURIComponent(cursor)}`);
export const moreRepliesHref = (back: string, cursor: string | null, parentId: string, last: CommentView) =>
  `${back}?${[pageQuery(cursor), `hilo=${parentId}&respuestas=${encodeURIComponent(cursorOf(last))}`].filter(Boolean).join("&")}#${commentAnchor(parentId)}`;
export const firstRepliesHref = (back: string, cursor: string | null, parentId: string) => `${back}${cursor === null ? "" : `?${pageQuery(cursor)}`}#${commentAnchor(parentId)}`;

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
