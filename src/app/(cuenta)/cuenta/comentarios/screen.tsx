"use client";

import { useActionState, useEffect, useRef } from "react";

import { longDate } from "@/app/_lib/dates";
import { comments as text } from "@/messages/es/comments";
import { t } from "@/messages/format";
import { lessonPath, ROUTES } from "@/services/account/navigation";
import type { MyComment } from "@/services/comments/comments";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { InlineAlert } from "@/ui/inline-alert";
import { PageHeader } from "@/ui/page-header";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { IDLE_MINE, MINE_FIELDS, mineHref, type MineNotice, type MineState } from "./outcomes";

// PA-24 · «Mis comentarios» (T-501): lo propio, con la lección y el curso de cada uno (enlace solo si la lección se ve) y
// «Borrar», que pregunta antes y lleva la revisión que se vio. Cada botón es un envío, así que funciona sin JavaScript. Lo oculto
// por moderación no llega: la base no lo da.
//
// T-616, 3b-3: arriba, la cabecera del rediseño sin foto, con «Volver a Cuenta» dentro, el antetítulo «Cuenta», el título y
// la entradilla; la lista va debajo, en la columna del formulario.

type MineAction = (previous: MineState, form: FormData) => Promise<MineState>;

export interface MyCommentsScreenProps {
  items: MyComment[];
  /** Desde dónde sigue la página siguiente; nulo si no hay más. */
  next: string | null;
  /** Desde dónde empieza esta página; nulo en la primera. */
  cursor: string | null;
  action: MineAction;
}

const GOOD = new Set<MineNotice["kind"]>(["deleted"]);

function Notice({ notice }: { notice: MineNotice | null }) {
  if (notice === null) return null;
  const words = notice.kind === "unavailable" ? text.mine.unavailable : text.notice[notice.kind];
  return (
    <InlineAlert tone={GOOD.has(notice.kind) ? "success" : "warning"} live>
      {words}
    </InlineAlert>
  );
}

export function MyCommentsScreen({ items, next, cursor, action }: MyCommentsScreenProps) {
  const [state, formAction, pending] = useActionState(action, IDLE_MINE, mineHref(cursor));
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = new Set(items.map((item) => item.id));
  // Lo que habla de un comentario que ya no está en la lista se dice arriba.
  const top = state.notice !== null && (state.notice.id === null || !shown.has(state.notice.id)) ? state.notice : null;

  // Después de borrar, el botón que se pulsó ya no está: el foco va al título, que se lee con el aviso.
  useEffect(() => {
    if (state.attempt === 0 || state.asking !== null) return;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost) heading.current?.focus();
  }, [state]);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col pb-24 outline-none sm:pb-8">
      <PageHeader
        above={<BackLink href={ROUTES.account}>{text.mine.back}</BackLink>}
        eyebrow={text.mine.eyebrow}
        title={text.mine.title}
        lead={text.mine.intro}
        titleRef={heading}
      />
      <div className="px-4 sm:px-8">
        <div className="flex max-w-form flex-col gap-6">
          <Notice notice={top} />
          {cursor !== null && items.length > 0 && <TextLink href={mineHref(null)}>{text.mine.newest}</TextLink>}
          {items.length === 0 ? (
            cursor === null ? (
              <p className="text-body text-text-2">{text.mine.empty}</p>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-body text-text-2">{text.mine.noMore}</p>
                <TextLink href={mineHref(null)}>{text.mine.newest}</TextLink>
              </div>
            )
          ) : (
            <ol className="flex flex-col divide-y divide-border">
              {items.map((item) => {
                const href = item.link === null ? null : lessonPath(item.link.slug, item.link.lessonId);
                return (
                  <li key={item.id}>
                    <article aria-label={t(text.mine.label, { lesson: item.lessonTitle, course: item.courseTitle })} className="flex flex-col gap-2 py-4">
                      <p className="flex flex-wrap items-center gap-x-2 text-body-s text-text-2">
                        {href === null ? <span className="font-semibold text-text">{item.lessonTitle}</span> : <TextLink href={href}>{item.lessonTitle}</TextLink>}
                        <span>{item.courseTitle}</span>
                        <time dateTime={item.createdAt}>{longDate(item.createdAt)}</time>
                        {item.edited && <span>{text.edited}</span>}
                        {item.isReply && <span>{text.mine.reply}</span>}
                        {item.state === "in_review" && <span className="text-label text-warning uppercase">{text.inReview}</span>}
                      </p>
                      {href === null && <p className="text-body-s text-text-2">{text.mine.gone}</p>}
                      {item.state === "in_review" && <p className="text-body-s text-text-2">{text.inReviewNote}</p>}
                      <p className="text-body break-words whitespace-pre-line text-text">{item.body}</p>
                      {state.notice !== null && state.notice.id === item.id && <Notice notice={state.notice} />}
                      <form action={formAction}>
                        {cursor !== null && <input type="hidden" name={MINE_FIELDS.from} value={cursor} />}
                        <Button type="submit" variant="text" name="do" value={`ask-delete:${item.id}`}>
                          {text.delete}
                        </Button>
                        {state.asking === item.id && (
                          <Dialog
                            title={text.confirmDelete.title}
                            busy={pending}
                            cancel={
                              <Button type="submit" variant="secondary" name="do" value="cancel">
                                {text.cancel}
                              </Button>
                            }
                            confirm={
                              <Button type="submit" variant="danger" name="do" value={`delete:${item.id}:${item.revision}`} pending={pending} loadingLabel={text.composer.sending}>
                                {text.confirmDelete.confirm}
                              </Button>
                            }
                          >
                            <p>{text.confirmDelete.body}</p>
                          </Dialog>
                        )}
                      </form>
                    </article>
                  </li>
                );
              })}
            </ol>
          )}
          {next !== null && <TextLink href={mineHref(next)}>{text.mine.more}</TextLink>}
        </div>
      </div>
    </main>
  );
}
