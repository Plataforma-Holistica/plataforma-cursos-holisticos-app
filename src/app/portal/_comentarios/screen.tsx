"use client";

import { Instead, Notice, StrayText, Thread, canWrite, useCommentThread } from "@/app/_comments/lesson-comments";
import { COMMENTS_ANCHOR } from "@/app/_comments/view";
import { comments as text } from "@/messages/es/comments";
import { t } from "@/messages/format";
import { lessonPath } from "@/services/account/navigation";
import type { GateRefusal, TeacherThread, WriteStanding } from "@/services/comments/comments";
import { TextLink } from "@/ui/text-link";

import { teacherCommentAction } from "./actions";

// PA-45 · la lista (T-501): cada comentario con su lección y su curso, el autor por su nombre de comentarios, sus respuestas,
// «Responder» y «Ver en la lección», y lo propio con «Editar» y «Borrar». Es el hilo de PA-22 (`useCommentThread`, `Thread`) con la
// lección de cada comentario. Si el portón no deja responder (cerrados, el veto, suspendido, el aviso pendiente), se lee y se dice
// por qué.

export interface TeacherCommentsProps {
  items: TeacherThread[];
  /** A donde vuelve un envío sin JavaScript: la página del portal con sus filtros. */
  here: string;
  /** Lo que contesta el portón; nulo sin comentarios. */
  write: "ok" | GateRefusal | null;
  unanswered: boolean;
}

const standingOf = (write: TeacherCommentsProps["write"]): WriteStanding => (write === null || write === "ok" ? { kind: "ok" } : { kind: "gate", answer: write });

export function TeacherComments({ items, here, write, unanswered }: TeacherCommentsProps) {
  const standing = standingOf(write);
  const { shared, heading, threadNotice, strayText } = useCommentThread({
    action: teacherCommentAction,
    here,
    items,
    write: standing,
    lessonOf: (threadId) => {
      const thread = items.find((each) => each.id === threadId) ?? items[0];
      return { slug: thread?.courseSlug ?? "", lessonId: thread?.lessonId ?? "" };
    },
  });
  return (
    <div id={COMMENTS_ANCHOR} className="flex flex-col gap-4">
      <h2 ref={heading} tabIndex={-1} className="sr-only">
        {text.portal.title}
      </h2>
      <Notice notice={threadNotice} />
      <StrayText text={strayText} />
      {!canWrite(standing) && items.length > 0 && <Instead write={standing} />}
      {items.length === 0 ? (
        <p className="text-body text-text-2">{unanswered ? text.portal.emptyUnanswered : text.portal.empty}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-border">
          {items.map((thread) => {
            const lesson = lessonPath(thread.courseSlug, thread.lessonId);
            const toLesson = lesson === null ? null : `${lesson}#${COMMENTS_ANCHOR}`;
            return (
              <Thread
                key={thread.id}
                thread={thread}
                shared={shared}
                identity={null}
                header={
                  <p className="flex flex-wrap items-center gap-x-3 pt-3 text-body-s text-text-2">
                    <span>{t(text.portal.where, { lesson: thread.lessonTitle, course: thread.courseTitle })}</span>
                    {toLesson !== null && <TextLink href={toLesson}>{text.portal.seeInLesson}</TextLink>}
                  </p>
                }
                moreReplies={toLesson}
                firstReplies={null}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}
