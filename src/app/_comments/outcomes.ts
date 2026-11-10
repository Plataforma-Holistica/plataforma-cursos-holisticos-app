import { commentSessionExit } from "@/app/_comments/session-exit";
import { lessonPath } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { SessionCheck } from "@/services/account/account";
import type { CommentDelete, CommentWrite, PseudonymChange } from "@/services/comments/comments";
import { COMMENT_FIELDS, IDLE_COMMENTS, type Carry, type CommentsState, type NoticeKind, type Open, type Place } from "@/app/_comments/state";

export { COMMENT_FIELDS, IDLE_COMMENTS };
export type { Carry, CommentNotice, CommentsState, NoticeKind, NoticePlace, Open, Place } from "@/app/_comments/state";

// Los comentarios de PA-22 (T-501; RF-801, RF-808; FL-15): qué pide cada botón y qué pinta la pantalla con cada respuesta.
// Una sola acción atiende todo el hilo, y su estado es uno: lo abierto (el campo de responder, el de editar, la pregunta de
// borrar o el diálogo del nombre), el aviso del último envío y dónde se dice, lo escrito que se queda y el comentario que se
// acaba de publicar. Abrir y cerrar no llaman a nadie: con JavaScript tardan un viaje, y sin él funcionan igual.
//
// El botón dice qué se pidió con lo que se vio (`do`): el comentario y su revisión al guardar o borrar, el comentario al
// que se responde. Lo escrito viaja en el estado porque React vacía el formulario al terminar la acción.

export type CommentRequest =
  | { kind: "post"; place: Exclude<Place, { kind: "edit" }>; body: string | null }
  | { kind: "save"; id: string; revision: number; body: string | null }
  | { kind: "delete"; id: string; revision: number }
  | { kind: "name"; pseudonym: string | null; carry: Carry | null; keep?: string }
  /** Abrir o cerrar algo. `kept`: lo escrito en el campo desde donde se abrió, que se queda («Cambiar» va dentro del campo). */
  | { kind: "open"; open: Open; kept?: { at: Place; body: string } }
  | { kind: "none" };

type State = Omit<CommentsState, "attempt">;

export type CommentOutcome = { kind: "redirect"; to: string; notice: Notice | null; closeSession: boolean } | { kind: "state"; state: State; refresh: boolean };

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REVISION = "[1-9][0-9]{0,14}";
const DO = new RegExp(`^(?:(post|ask-name|cancel)|(reply|open-reply|ask-edit|ask-delete):(${ID})|(save|delete):(${ID}):(${REVISION}))$`);
const IS_ID = new RegExp(`^${ID}$`);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** El único valor de un campo, o nulo si falta, se repite o no es texto. */
function single(form: FormData, field: string): string | null {
  const values = form.getAll(field);
  const [value] = values;
  return values.length === 1 && typeof value === "string" ? value : null;
}

const optional = (form: FormData, field: string): string | null | undefined => (form.getAll(field).length === 0 ? undefined : single(form, field));

const placeOf = (carry: Carry): Exclude<Place, { kind: "edit" }> => (carry.parentId === null ? { kind: "new" } : { kind: "reply", parentId: carry.parentId });

/** De qué lección es el formulario, y a dónde se vuelve. Sin las dos cosas con forma, ninguna. */
export function readCommentLesson(form: unknown): { slug: string; lessonId: string; back: string } | null {
  if (!(form instanceof FormData)) return null;
  const slug = single(form, COMMENT_FIELDS.course);
  const lessonId = single(form, COMMENT_FIELDS.lesson);
  if (slug === null || lessonId === null || slug.length > 100 || !SLUG.test(slug) || !IS_ID.test(lessonId)) return null;
  const back = lessonPath(slug, lessonId);
  return back === null ? null : { slug, lessonId, back };
}

/** Qué botón se pulsó, con lo que lleva. Sin uno, con más de uno, o con algo que no tiene forma, cuenta como vacío. */
export function readCommentForm(form: unknown): CommentRequest {
  if (!(form instanceof FormData)) return { kind: "none" };
  const value = single(form, "do");
  if (value === "name") return readNameForm(form);
  const match = value === null || value.length > 120 ? null : DO.exec(value);
  if (match === null) return { kind: "none" };
  const [, plain, withId, id, withRevision, revisedId, revisionText] = match;
  const body = optional(form, COMMENT_FIELDS.body) ?? null;
  if (plain === "post") return { kind: "post", place: { kind: "new" }, body };
  if (plain === "cancel") return readCancel(form);
  if (plain === "ask-name") {
    if (body === null || body === "") return { kind: "open", open: { kind: "name", carry: null } };
    return { kind: "open", open: { kind: "name", carry: null, keep: body }, kept: { at: { kind: "new" }, body } };
  }
  if (withId !== undefined && id !== undefined) {
    switch (withId) {
      case "reply":
        return { kind: "post", place: { kind: "reply", parentId: id }, body };
      case "open-reply":
        return { kind: "open", open: { kind: "reply", parentId: id } };
      case "ask-edit":
        return { kind: "open", open: { kind: "edit", id } };
      default:
        return { kind: "open", open: { kind: "delete", id } };
    }
  }
  if (withRevision !== undefined && revisedId !== undefined && revisionText !== undefined) {
    const revision = Number(revisionText);
    if (!Number.isSafeInteger(revision)) return { kind: "none" };
    return withRevision === "save" ? { kind: "save", id: revisedId, revision, body } : { kind: "delete", id: revisedId, revision };
  }
  return { kind: "none" };
}

/** Lo que el diálogo del nombre lleva consigo: lo que cruza para publicarse, o lo que conserva del campo de arriba. */
function readDialogText(form: FormData): { carry: Carry | null; keep: string | undefined } | null {
  const carried = optional(form, COMMENT_FIELDS.carry);
  const parent = optional(form, COMMENT_FIELDS.carryParent);
  const keep = optional(form, COMMENT_FIELDS.keep);
  if (carried === null || parent === null || keep === null) return null;
  if (parent !== undefined && (carried === undefined || !IS_ID.test(parent))) return null;
  return { carry: carried === undefined ? null : { parentId: parent ?? null, body: carried }, keep };
}

/** Elegir el nombre: el seudónimo y, si cruzaba algo, lo escrito y a qué respondía. */
function readNameForm(form: FormData): CommentRequest {
  const pseudonym = optional(form, COMMENT_FIELDS.name);
  const text = readDialogText(form);
  if (pseudonym === null || text === null) return { kind: "none" };
  const request = { kind: "name", pseudonym: pseudonym ?? null, carry: text.carry } as const;
  return text.keep === undefined ? request : { ...request, keep: text.keep };
}

/** Cancelar. Desde el diálogo del nombre, lo que llevaba vuelve a su campo: sin JavaScript, solo así no se pierde. */
function readCancel(form: FormData): CommentRequest {
  const text = readDialogText(form);
  const open = { kind: "none" } as const;
  // Desde una respuesta, su campo se vuelve a abrir con lo escrito.
  if (text?.carry != null) {
    const place = placeOf(text.carry);
    return { kind: "open", open: place.kind === "reply" ? { kind: "reply", parentId: place.parentId } : open, kept: { at: place, body: text.carry.body } };
  }
  if (text?.keep !== undefined) return { kind: "open", open, kept: { at: { kind: "new" }, body: text.keep } };
  return { kind: "open", open };
}

/** Abrir o cerrar: lo pedido, sin aviso, y lo escrito en el campo desde donde se abrió. */
export function askState(request: Extract<CommentRequest, { kind: "open" }>): CommentsState {
  return { ...IDLE_COMMENTS, open: request.open, kept: request.kept ?? null };
}

const state = (fields: Partial<State>, refresh: boolean): CommentOutcome => ({
  kind: "state",
  refresh,
  state: { open: { kind: "none" }, notice: null, kept: null, written: null, ...fields },
});

/** La sesión que no pasó: a entrar, a completar la cuenta o a la lección, donde decide la guarda. Nulo si no se supo. */
const sessionExit = commentSessionExit;

const openOf = (place: Place): Open => (place.kind === "new" ? { kind: "none" } : place.kind === "reply" ? { kind: "reply", parentId: place.parentId } : { kind: "edit", id: place.id });

/** Lo que no se pudo escribir se dice en su campo, que se queda abierto y con lo escrito. */
const keep = (place: Place, body: string, kind: NoticeKind, refresh: boolean): CommentOutcome =>
  state({ open: openOf(place), notice: { at: place, kind }, kept: { at: place, body } }, refresh);

/** Lo que pinta la pantalla después de publicar, responder o editar. */
export function writeOutcome(place: Place, body: string, result: CommentWrite, back: string): CommentOutcome {
  switch (result.kind) {
    case "written":
      // Su campo queda vacío: lo escrito ya es el comentario.
      return state(
        { notice: { at: { kind: "comment", id: result.id }, kind: result.state === "published" ? "published" : "in_review" }, kept: { at: place, body: "" }, written: result.id },
        true,
      );
    case "gate":
      switch (result.answer) {
        case "needs_pseudonym":
          if (place.kind === "edit") return keep(place, body, "unavailable", false);
          // Lo escrito cruza el diálogo y se queda en su campo: si se cancela, no se pierde.
          return state({ open: { kind: "name", carry: { parentId: place.kind === "reply" ? place.parentId : null, body } }, kept: { at: place, body } }, false);
        case "not_found":
        case "suspended_account":
          return state({ notice: { at: { kind: "thread" }, kind: "no_lesson" } }, true);
        default:
          // Lo que la pantalla pinta en lugar del campo cambió: se vuelve a pintar, y lo escrito se queda.
          return keep(place, body, result.answer, true);
      }
    case "changed":
      // Lo escrito no vuelve: con la revisión nueva, un segundo clic pisaría lo que cambió la otra pestaña.
      return state({ notice: { at: place.kind === "edit" ? { kind: "comment", id: place.id } : { kind: "thread" }, kind: "changed" }, kept: { at: place, body: "" } }, true);
    case "not_found":
      // Al editar, es lo borrado en otra pestaña; al publicar, la lección que ya no se ve.
      return place.kind === "edit"
        ? state({ notice: { at: { kind: "thread" }, kind: "gone" }, kept: { at: place, body: "" } }, true)
        : state({ notice: { at: { kind: "thread" }, kind: "no_lesson" } }, true);
    case "no_access":
    case "suspended_account":
      return state({ notice: { at: { kind: "thread" }, kind: "no_lesson" } }, true);
    case "read_only":
      return keep(place, body, "read_only", true);
    case "bad_parent":
      return keep(place, body, "bad_parent", true);
    case "hidden":
      // Lo oculto por reportes ya no se edita: el campo se cierra y lo escrito se muestra arriba, para copiarlo.
      return state({ notice: { at: place.kind === "edit" ? { kind: "comment", id: place.id } : { kind: "thread" }, kind: "hidden" }, kept: { at: place, body } }, true);
    case "throttled":
      return keep(place, body, "throttled", false);
    case "invalid":
      return keep(place, body, result.reason === "too_short" ? "invalid" : result.reason, false);
    case "unavailable":
      return keep(place, body, "unavailable", false);
    case "session":
      return sessionExit(result.check as Exclude<SessionCheck, { kind: "pass" }>, back) ?? keep(place, body, "unavailable", false);
  }
}

/** Lo que pinta la pantalla después de borrar lo propio. */
export function deleteOutcome(id: string, result: CommentDelete, back: string): CommentOutcome {
  switch (result.kind) {
    case "deleted":
      return state({ notice: { at: { kind: "thread" }, kind: "deleted" } }, true);
    case "not_found":
      return state({ notice: { at: { kind: "thread" }, kind: "gone" } }, true);
    case "changed":
      return state({ notice: { at: { kind: "comment", id }, kind: "changed" } }, true);
    case "hidden":
      return state({ notice: { at: { kind: "comment", id }, kind: "hidden" } }, true);
    case "unavailable":
      return state({ open: { kind: "delete", id }, notice: { at: { kind: "comment", id }, kind: "unavailable" } }, false);
    case "session":
      return sessionExit(result.check as Exclude<SessionCheck, { kind: "pass" }>, back) ?? state({ open: { kind: "delete", id }, notice: { at: { kind: "comment", id }, kind: "unavailable" } }, false);
  }
}

/**
 * Lo que sigue a elegir el nombre: si cruzaba algo, publicarlo (`post`); si no, lo que pinta la pantalla. Un nombre que no
 * sirve deja el diálogo abierto con lo escrito; con el veto o cerrado, lo que cruzaba vuelve a su campo.
 */
export function nameOutcome(
  result: PseudonymChange,
  typed: string,
  carry: Carry | null,
  back: string,
  kept?: string,
): CommentOutcome | { kind: "post"; place: Exclude<Place, { kind: "edit" }>; body: string } {
  const open: Open = kept === undefined ? { kind: "name", carry } : { kind: "name", carry, keep: kept };
  const stay = (kind: NoticeKind): CommentOutcome => state({ open, notice: { at: { kind: "name" }, kind }, kept: { at: { kind: "name" }, body: typed } }, false);
  // Lo que el diálogo conservaba del campo de arriba («Cambiar») vuelve a su campo.
  const restored = kept === undefined ? null : { at: { kind: "new" } as const, body: kept };
  const closeWith = (kind: NoticeKind): CommentOutcome =>
    carry === null ? state({ notice: { at: { kind: "thread" }, kind }, kept: restored }, true) : keep(placeOf(carry), carry.body, kind, true);
  switch (result.kind) {
    case "saved":
      return carry === null ? state({ notice: { at: { kind: "thread" }, kind: "name_saved" }, kept: restored }, true) : { kind: "post", place: placeOf(carry), body: carry.body };
    case "invalid":
      return stay(`name_${result.reason}`);
    case "flagged":
    case "throttled":
      return stay(`name_${result.kind}`);
    case "unavailable":
      return stay("unavailable");
    case "banned":
    case "closed":
      return closeWith(result.kind);
    case "suspended_account":
      return closeWith("no_lesson");
    case "session":
      return sessionExit(result.check as Exclude<SessionCheck, { kind: "pass" }>, back) ?? stay("unavailable");
  }
}
