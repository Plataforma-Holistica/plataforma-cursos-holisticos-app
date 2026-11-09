// El estado de los comentarios de una lección (PA-22; T-501), el que comparten la acción y la pantalla: lo abierto (el campo
// de responder, el de editar, la pregunta de borrar o el diálogo del nombre), el aviso del último envío y dónde se dice, lo
// escrito que se queda y el comentario que se acaba de publicar. Qué hace la acción con cada respuesta vive en
// `comment-outcomes.ts`, junto a la lección.

export const COMMENT_FIELDS = {
  course: "curso",
  lesson: "leccion",
  body: "texto",
  name: "seudonimo",
  /** Lo escrito que cruza el diálogo del nombre, y a qué respondía. */
  carry: "cruza",
  carryParent: "cruza-padre",
  /** Lo escrito en el campo de arriba cuando se abrió el diálogo con «Cambiar»: vuelve a su campo, también sin JavaScript. */
  keep: "conserva",
} as const;

/** Dónde se escribe: el campo de arriba, el de responder a un comentario o el de editar uno propio. */
export type Place = { kind: "new" } | { kind: "reply"; parentId: string } | { kind: "edit"; id: string };

/** Lo escrito que cruza el diálogo del nombre, y a qué respondía. */
export interface Carry {
  parentId: string | null;
  body: string;
}

export type Open =
  | { kind: "none" }
  | { kind: "reply"; parentId: string }
  | { kind: "edit"; id: string }
  | { kind: "delete"; id: string }
  /** `keep`: lo que había en el campo de arriba al pulsar «Cambiar»; no se publica, vuelve a su campo. */
  | { kind: "name"; carry: Carry | null; keep?: string };

export type NoticeKind =
  | "published"
  | "in_review"
  | "deleted"
  | "name_saved"
  | "changed"
  | "gone"
  | "bad_parent"
  | "throttled"
  | "empty"
  | "too_long"
  | "invalid"
  | "closed"
  | "banned"
  | "suspended"
  | "needs_notice"
  | "read_only"
  | "no_lesson"
  | "unavailable"
  | "name_empty"
  | "name_too_short"
  | "name_too_long"
  | "name_invalid"
  | "name_flagged"
  | "name_throttled"
  | "hidden";

export type NoticePlace = Place | { kind: "comment"; id: string } | { kind: "thread" } | { kind: "name" };

export interface CommentNotice {
  at: NoticePlace;
  kind: NoticeKind;
}

export interface CommentsState {
  attempt: number;
  open: Open;
  notice: CommentNotice | null;
  /** Lo que su campo debe tener ahora: lo escrito que se queda, o vacío si se publicó. */
  kept: { at: Place | { kind: "name" }; body: string } | null;
  /** El comentario que se acaba de publicar o guardar: ahí va el foco. */
  written: string | null;
}

export const IDLE_COMMENTS: CommentsState = { attempt: 0, open: { kind: "none" }, notice: null, kept: null, written: null };

