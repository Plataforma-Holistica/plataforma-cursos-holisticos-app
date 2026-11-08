"use client";

import { Ellipsis } from "lucide";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";

import { longDate } from "@/app/_lib/dates";
import { comments as text } from "@/messages/es/comments";
import { plural, t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import type { CommentThread, CommentView, WriteStanding } from "@/services/comments/comments";
import { Button } from "@/ui/button";
import { CountedField } from "@/ui/counted-field";
import { cx } from "@/ui/cx";
import { Dialog } from "@/ui/dialog";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { TextField } from "@/ui/text-field";
import { TextLink } from "@/ui/text-link";

import { COMMENT_FIELDS, IDLE_COMMENTS, type CommentNotice, type CommentsState, type NoticePlace, type Place } from "./state";
import {
  COMMENTS_ANCHOR,
  avatarOf,
  commentAnchor,
  firstRepliesHref,
  moreCommentsHref,
  moreRepliesHref,
  newestCommentsHref,
  type CommentsView,
} from "./view";

// Los comentarios de una lección (PA-22; diseño §5.12; T-501; RF-801, RF-808; FL-15). El hilo, cada comentario y el campo, con
// un solo estado para todo el hilo (`comment-outcomes.ts`): lo abierto, el aviso y lo escrito que se queda. Cada botón es un
// envío que dice qué pide con lo que se vio, así que todo funciona también sin JavaScript; con él, la acción vuelve a pintar
// la página cuando algo cambió.
//
// Las páginas van por la dirección y no se acumulan: «Ver más comentarios» lleva a la siguiente y «Más recientes» vuelve a la
// primera; igual las respuestas de un comentario. En lo ajeno no hay menú hasta T-502 (reportar).

type CommentAction = (previous: CommentsState, form: FormData) => Promise<CommentsState>;

export interface LessonCommentsProps {
  slug: string;
  lessonId: string;
  /** La dirección de la lección, sin parámetros. */
  back: string;
  view: CommentsView;
  /** Con qué nombre aparece el maestro del curso. */
  teacherName: string;
  action: CommentAction;
}

const COMMENT_WARN_AT = 3_800;
const COMMENT_MAX = 4_000;

const samePlace = (a: NoticePlace, b: NoticePlace) => JSON.stringify(a) === JSON.stringify(b);
const noticeAt = (state: CommentsState, at: NoticePlace): CommentNotice | null => (state.notice !== null && samePlace(state.notice.at, at) ? state.notice : null);
/** La llave de cada campo del hilo, para su borrador. */
const placeKey = (at: Place | { kind: "name" }): string =>
  at.kind === "new" ? "new" : at.kind === "reply" ? `reply:${at.parentId}` : at.kind === "edit" ? `edit:${at.id}` : "name";

/**
 * Lo escrito en cada campo del hilo lo lleva la pantalla, no el formulario: React 19 devuelve al valor por omisión el formulario
 * que envió, y un campo que se cierra al abrir otra cosa se desmonta. Cada respuesta dice qué debe tener un campo (`kept`): lo
 * escrito que se queda, o vacío si se publicó. Sin JavaScript, el primer pintado lo trae del estado que mandó el servidor.
 */
type Drafts = Readonly<Record<string, string>>;
function withKept(drafts: Drafts, state: CommentsState): Drafts {
  if (state.kept === null) return drafts;
  const next: Record<string, string> = { ...drafts };
  if (state.kept.body === "") delete next[placeKey(state.kept.at)];
  else next[placeKey(state.kept.at)] = state.kept.body;
  return next;
}

/** Si se puede escribir: el campo, o el sustituto que lo dice (diseño §5.12, «Variantes que sustituyen al campo»). */
const canWrite = (write: WriteStanding) => write.kind === "ok" || (write.kind === "gate" && write.answer === "needs_pseudonym");

function Notice({ notice }: { notice: CommentNotice | null }) {
  if (notice === null) return null;
  const good = notice.kind === "published" || notice.kind === "in_review" || notice.kind === "deleted" || notice.kind === "name_saved";
  return (
    <InlineAlert tone={good ? "success" : "warning"} live>
      {text.notice[notice.kind]}
    </InlineAlert>
  );
}

function Instead({ write }: { write: WriteStanding }) {
  let body: ReactNode = text.instead.unavailable;
  if (write.kind === "read_only") body = text.instead.readOnly;
  if (write.kind === "gate") {
    switch (write.answer) {
      case "banned":
        body = text.instead.banned;
        break;
      case "suspended":
        body = text.instead.suspended;
        break;
      case "closed":
        body = text.instead.closed;
        break;
      case "needs_notice":
        body = (
          <>
            {text.instead.needsNotice} <TextLink href={ROUTES.portal}>{text.instead.needsNoticeLink}</TextLink>
          </>
        );
        break;
      default:
        break;
    }
  }
  return <p className="rounded-md border border-border bg-surface-1 p-4 text-body text-text-2">{body}</p>;
}

/** Los dos campos que dicen de qué lección es cada formulario. */
function LessonFields({ slug, lessonId }: { slug: string; lessonId: string }) {
  return (
    <>
      <input type="hidden" name={COMMENT_FIELDS.course} value={slug} />
      <input type="hidden" name={COMMENT_FIELDS.lesson} value={lessonId} />
    </>
  );
}

function Avatar({ name, teacher }: { name: string; teacher: boolean }) {
  const { initial, tone } = avatarOf(name);
  return (
    <span
      data-avatar
      aria-hidden="true"
      className={cx("grid size-9 shrink-0 place-items-center rounded-full bg-linear-to-br text-body-s font-semibold text-text", TONE_CLASSES[tone], teacher && "ring-2 ring-accent")}
    >
      {initial}
    </span>
  );
}

// Escritas enteras: Tailwind no ve una clase armada con texto.
const TONE_CLASSES: Record<number, string> = {
  1: "from-cover-1-deep to-cover-1",
  2: "from-cover-2-deep to-cover-2",
  3: "from-cover-3-deep to-cover-3",
  4: "from-cover-4-deep to-cover-4",
  5: "from-cover-5-deep to-cover-5",
  6: "from-cover-6-deep to-cover-6",
  7: "from-cover-7-deep to-cover-7",
  8: "from-cover-8-deep to-cover-8",
};

interface Shared {
  slug: string;
  lessonId: string;
  state: CommentsState;
  formAction: (form: FormData) => void;
  pending: boolean;
  standing: WriteStanding;
  /** Lo escrito en ese campo, o nulo si no se ha escrito nada. */
  draft: (at: Place | { kind: "name" }) => string | null;
  /** Lo que se escribe en ese campo. */
  write: (at: Place | { kind: "name" }) => (value: string) => void;
}

/** Un comentario o una respuesta (diseño §5.12, `Comment`). */
function CommentItem({ comment, reply, shared, children }: { comment: CommentView; reply: boolean; shared: Shared; children?: ReactNode }) {
  const { slug, lessonId, state, formAction, pending, standing, draft, write } = shared;
  if (comment.state === "deleted") {
    return (
      <article id={commentAnchor(comment.id)} aria-label={text.deleted} tabIndex={-1} className="flex flex-col gap-1 py-2 outline-none">
        <p className="text-body-s text-text-2 italic">{text.deleted}</p>
        {children}
      </article>
    );
  }
  const author = comment.own ? text.you : (comment.name ?? text.deleted);
  const editing = comment.own && state.open.kind === "edit" && state.open.id === comment.id && comment.revision !== null;
  const deleting = comment.own && state.open.kind === "delete" && state.open.id === comment.id && comment.revision !== null;
  return (
    <article
      id={commentAnchor(comment.id)}
      aria-label={author}
      tabIndex={-1}
      className={cx("flex gap-3 py-3 outline-none", comment.teacher && "border-l-2 border-accent pl-3")}
    >
      {/* Lo propio dice «Tú», y su avatar sale del nombre con que lo ven los demás. */}
      <Avatar name={comment.name ?? author} teacher={comment.teacher} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-2 text-body-s text-text-2">
          <span className="font-semibold text-text">{author}</span>
          {comment.teacher && <span className="text-label text-accent uppercase">{text.teacher}</span>}
          <time dateTime={comment.createdAt}>{longDate(comment.createdAt)}</time>
          {comment.edited && <span>{text.edited}</span>}
          {comment.own && comment.state === "in_review" && <span className="text-label text-warning uppercase">{text.inReview}</span>}
        </p>
        {comment.own && comment.state === "in_review" && <p className="text-body-s text-text-2">{text.inReviewNote}</p>}
        {editing ? (
          <form action={formAction} className="flex flex-col gap-3">
            <LessonFields slug={slug} lessonId={lessonId} />
            <CountedField
              id={`editar-${comment.id}`}
              name={COMMENT_FIELDS.body}
              label={text.composer.editLabel}
              max={COMMENT_MAX}
              warnAt={COMMENT_WARN_AT}
              defaultValue=""
              value={draft({ kind: "edit", id: comment.id }) ?? comment.body ?? ""}
              onValueChange={write({ kind: "edit", id: comment.id })}
              error={null}
              multiline
            />
            <Notice notice={noticeAt(state, { kind: "edit", id: comment.id })} />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="text" name="do" value="cancel">
                {text.cancel}
              </Button>
              <Button type="submit" variant="secondary" name="do" value={`save:${comment.id}:${comment.revision}`} pending={pending} loadingLabel={text.composer.sending}>
                {text.save}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-body break-words whitespace-pre-line text-text">{comment.body}</p>
        )}
        <Notice notice={noticeAt(state, { kind: "comment", id: comment.id })} />
        {!editing && (
          <form action={formAction} className="flex flex-wrap items-center gap-3">
            <LessonFields slug={slug} lessonId={lessonId} />
            {!reply && canWrite(standing) && comment.state === "published" && (
              <Button type="submit" variant="text" name="do" value={`open-reply:${comment.id}`}>
                {text.reply}
              </Button>
            )}
            {comment.own && comment.revision !== null && (
              // Se vuelve a montar con cada respuesta: así se cierra, también al cancelar lo que abrió.
              <details key={state.attempt} className="relative">
                <summary className="grid min-h-touch min-w-touch cursor-pointer list-none place-items-center rounded-md text-text-2 hover:bg-surface-2">
                  <Icon icon={Ellipsis} size={20} />
                  <span className="sr-only">{text.options}</span>
                </summary>
                <div className="absolute z-(--z-dropdown) mt-1 flex flex-col rounded-md border border-border bg-surface-1 p-1 shadow-overlay">
                  {canWrite(standing) && (
                    <Button type="submit" variant="text" name="do" value={`ask-edit:${comment.id}`}>
                      {text.edit}
                    </Button>
                  )}
                  <Button type="submit" variant="text" name="do" value={`ask-delete:${comment.id}`}>
                    {text.delete}
                  </Button>
                </div>
              </details>
            )}
          </form>
        )}
        {deleting && (
          <form action={formAction}>
            <LessonFields slug={slug} lessonId={lessonId} />
            <Dialog
              title={text.confirmDelete.title}
              busy={pending}
              cancel={
                <Button type="submit" variant="secondary" name="do" value="cancel">
                  {text.cancel}
                </Button>
              }
              confirm={
                <Button type="submit" variant="danger" name="do" value={`delete:${comment.id}:${comment.revision}`} pending={pending} loadingLabel={text.composer.sending}>
                  {text.confirmDelete.confirm}
                </Button>
              }
            >
              <p>{text.confirmDelete.body}</p>
            </Dialog>
          </form>
        )}
        {children}
      </div>
    </article>
  );
}

/** El campo para escribir (diseño §5.12, `CommentComposer`): arriba del hilo, o bajo un comentario para responderle. */
function Composer({ place, label, shared, identity, onCancel }: { place: Exclude<Place, { kind: "edit" }>; label: string; shared: Shared; identity: ReactNode; onCancel: boolean }) {
  const { slug, lessonId, state, formAction, pending, draft, write } = shared;
  const id = place.kind === "new" ? "comentar" : `responder-${place.parentId}`;
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <LessonFields slug={slug} lessonId={lessonId} />
      <CountedField
        id={id}
        name={COMMENT_FIELDS.body}
        label={label}
        max={COMMENT_MAX}
        warnAt={COMMENT_WARN_AT}
        defaultValue=""
        value={draft(place) ?? ""}
        onValueChange={write(place)}
        error={null}
        multiline
      />
      <Notice notice={noticeAt(state, place)} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-body-s text-text-2">{identity}</div>
        <div className="flex gap-3">
          {onCancel && (
            <Button type="submit" variant="text" name="do" value="cancel">
              {text.cancel}
            </Button>
          )}
          <Button type="submit" variant="secondary" name="do" value={place.kind === "new" ? "post" : `reply:${place.parentId}`} pending={pending} loadingLabel={text.composer.sending}>
            {place.kind === "new" ? text.composer.submit : text.reply}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Quién va a aparecer: el seudónimo, el maestro con su nombre, o el aviso de que lo va a elegir. «Cambiar» va solo en el campo de
 * arriba: lo escrito ahí se queda mientras se elige.
 */
function Identity({ me, teacherName, changeable }: { me: CommentsView["me"]; teacherName: string; changeable: boolean }) {
  if (me.teacher) return <p>{t(text.composer.asTeacher, { name: teacherName })}</p>;
  if (me.pseudonym === null) return <p>{text.composer.choose}</p>;
  return (
    <p className="flex flex-wrap items-center gap-x-1">
      {t(text.composer.as, { name: me.pseudonym })}
      {changeable && (
        <>
          {" "}
          <Button type="submit" variant="text" name="do" value="ask-name">
            {text.composer.change}
          </Button>
        </>
      )}
    </p>
  );
}

/** El diálogo del nombre (FL-15 paso 3): vacío, sin el nombre, el alias ni el correo; lo escrito cruza en campos ocultos. */
function NameDialog({ shared }: { shared: Shared }) {
  const { slug, lessonId, state, formAction, pending, draft, write } = shared;
  if (state.open.kind !== "name") return null;
  const { carry, keep } = state.open;
  const notice = noticeAt(state, { kind: "name" });
  return (
    <form action={formAction}>
      <LessonFields slug={slug} lessonId={lessonId} />
      {carry !== null && <input type="hidden" name={COMMENT_FIELDS.carry} value={carry.body} />}
      {keep !== undefined && <input type="hidden" name={COMMENT_FIELDS.keep} value={keep} />}
      {carry?.parentId != null && <input type="hidden" name={COMMENT_FIELDS.carryParent} value={carry.parentId} />}
      <Dialog
        title={text.name.title}
        busy={pending}
        cancel={
          <Button type="submit" variant="secondary" name="do" value="cancel">
            {text.cancel}
          </Button>
        }
        confirm={
          <Button type="submit" variant="primary" name="do" value="name" pending={pending} loadingLabel={text.composer.sending}>
            {carry === null ? text.name.save : text.name.saveAndPost}
          </Button>
        }
        extra={
          <TextField
            id={`${COMMENTS_ANCHOR}-nombre`}
            name={COMMENT_FIELDS.name}
            label={text.name.label}
            hint={text.name.hint}
            autoComplete="off"
            value={draft({ kind: "name" }) ?? ""}
            onValueChange={write({ kind: "name" })}
            error={notice === null ? undefined : text.notice[notice.kind]}
          />
        }
      >
        <p>{text.name.body}</p>
      </Dialog>
    </form>
  );
}

function Thread({ thread, back, cursor, shared, pagedThread, identity }: { thread: CommentThread; back: string; cursor: string | null; shared: Shared; pagedThread: string | null; identity: ReactNode }) {
  const { state } = shared;
  const replying = state.open.kind === "reply" && state.open.parentId === thread.id && canWrite(shared.standing) && thread.state === "published";
  const last = thread.replies.items.at(-1);
  return (
    <li>
      <CommentItem comment={thread} reply={false} shared={shared}>
      {/* Las respuestas van dentro del comentario al que responden. */}
      {(thread.replies.items.length > 0 || replying || pagedThread === thread.id) && (
        <div className="ml-6 flex flex-col gap-1">
          {pagedThread === thread.id && <TextLink href={firstRepliesHref(back, cursor, thread.id)}>{text.firstReplies}</TextLink>}
          {thread.replies.items.length > 0 && (
            <ol className="flex flex-col">
              {thread.replies.items.map((reply) => (
                <li key={reply.id}>
                  <CommentItem comment={reply} reply shared={shared} />
                </li>
              ))}
            </ol>
          )}
          {thread.replies.more && last !== undefined && <TextLink href={moreRepliesHref(back, cursor, thread.id, last)}>{text.moreReplies}</TextLink>}
          {replying && (
            <Composer
              place={{ kind: "reply", parentId: thread.id }}
              label={t(text.composer.replyLabel, { name: thread.own ? text.you : (thread.name ?? text.deleted) })}
              shared={shared}
              identity={identity}
              onCancel
            />
          )}
        </div>
      )}
      </CommentItem>
    </li>
  );
}

/** Lo que se abrió o se cerró, de qué comentario: a él vuelve el foco al cerrarse. */
const openedOn = (open: CommentsState["open"]): string | null =>
  open.kind === "edit" || open.kind === "delete" ? open.id : open.kind === "reply" ? open.parentId : null;

export function LessonComments({ slug, lessonId, back, view, teacherName, action }: LessonCommentsProps) {
  // Sin JavaScript, el envío vuelve a lo que se estaba viendo: la misma página de comentarios.
  const [state, formAction, pending] = useActionState(action, IDLE_COMMENTS, `${view.here}#${COMMENTS_ANCHOR}`);
  const [drafts, setDrafts] = useState<Drafts>(() => withKept({}, state));
  const [seen, setSeen] = useState(state.attempt);
  // Con cada respuesta, lo que dice de un campo (React vuelve a pintar antes de mostrar esta vuelta). El diálogo del nombre
  // abre siempre vacío, salvo con el nombre que no sirvió.
  if (seen !== state.attempt) {
    setSeen(state.attempt);
    const next = withKept(drafts, state);
    const nameKept = state.kept !== null && state.kept.at.kind === "name";
    setDrafts(state.open.kind === "name" && !nameKept ? Object.fromEntries(Object.entries(next).filter(([key]) => key !== "name")) : next);
  }
  const shared: Shared = {
    slug,
    lessonId,
    state,
    formAction,
    pending,
    standing: view.write,
    draft: (at) => drafts[placeKey(at)] ?? null,
    write: (at) => (value) => setDrafts((current) => ({ ...current, [placeKey(at)]: value })),
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const lastOpened = useRef<string | null>(null);
  const shown = new Set(view.items.flatMap((thread) => [thread.id, ...thread.replies.items.map((reply) => reply.id)]));
  // Lo que se dice de un comentario que no está en esta página (lo nuevo cae en la primera) se dice arriba del hilo.
  const at = state.notice?.at;
  const orphan =
    at !== undefined &&
    ((at.kind === "comment" && !shown.has(at.id)) || (!canWrite(view.write) && (at.kind === "new" || at.kind === "reply")));
  const threadNotice = orphan ? state.notice : noticeAt(state, { kind: "thread" });

  // El foco después de cada respuesta: al campo que se abrió, al comentario publicado o guardado, o al comentario que se cerró
  // (el botón que se pulsó ya no está). Los diálogos llevan el suyo.
  useEffect(() => {
    if (state.attempt === 0) return;
    const before = lastOpened.current;
    lastOpened.current = openedOn(state.open);
    const byId = (id: string) => document.getElementById(id);
    if (state.open.kind === "edit") return void byId(`editar-${state.open.id}`)?.focus();
    if (state.open.kind === "reply") return void byId(`responder-${state.open.parentId}`)?.focus();
    if (state.open.kind !== "none") return;
    const written = state.written === null ? null : byId(commentAnchor(state.written));
    if (written !== null) return void written.focus();
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!lost) return;
    const at = state.notice?.at;
    const target = (at?.kind === "comment" ? byId(commentAnchor(at.id)) : null) ?? (before === null ? null : byId(commentAnchor(before)));
    (target ?? heading.current)?.focus();
  }, [state]);

  return (
    <div id={COMMENTS_ANCHOR} className="flex flex-col gap-4">
      <h2 ref={heading} tabIndex={-1} className="text-h3 outline-none">
        {t(plural(view.count, text.title), { count: view.count })}
      </h2>
      <Notice notice={threadNotice} />
      {canWrite(view.write) ? (
        <>
          <Composer place={{ kind: "new" }} label={text.composer.label} shared={shared} identity={<Identity me={view.me} teacherName={teacherName} changeable />} onCancel={false} />
          <NameDialog shared={shared} />
        </>
      ) : (
        <Instead write={view.write} />
      )}
      {view.paged && <TextLink href={newestCommentsHref(back)}>{text.newest}</TextLink>}
      {view.items.length === 0 && !view.paged ? (
        <p className="text-body text-text-2">{text.empty}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-border">
          {view.items.map((thread) => (
            <Thread
              key={thread.id}
              thread={thread}
              back={back}
              cursor={view.cursor}
              shared={shared}
              pagedThread={view.pagedThread}
              identity={<Identity me={view.me} teacherName={teacherName} changeable={false} />}
            />
          ))}
        </ol>
      )}
      {view.next !== null && <TextLink href={moreCommentsHref(back, view.next)}>{text.more}</TextLink>}
    </div>
  );
}
