"use client";

import dynamic from "next/dynamic";
import { useActionState, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { approveAction, lessonVideoAction, reviewCodeAction } from "./actions";
import type { CodeState, ReviewFailure, ReviewState, VideoAnswer } from "./outcomes";
import type { CourseRow, LessonRow, ReviewView } from "./rows";

// PA-61 y PA-62 mínimas · Los cursos por revisar, en una sola pantalla (decisión de Sergio del
// 2026-10-14): la cola, las lecciones de cada curso, el reproductor y aprobar. Devolver al
// maestro, las notas y la lista del revisor llegan con T-405.
//
// Aprobar funciona sin JavaScript; reproducir no, y la pantalla lo dice. Los botones «Ver» se
// pintan solo ya montada la pantalla en el navegador.
//
// El video no va en el HTML (RF-305): al pulsar «Ver» se pide su dirección firmada con una
// acción, y el reproductor (Mux Player) se descarga entonces. Si la dirección caduca a media
// reproducción, se pide otra una sola vez, desde el mismo segundo.

const text = admin.review;
const CODE_IDLE: CodeState = { kind: "idle" };
const QUEUE_IDLE: ReviewState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const CODE_BLOCK_ID = "bloque-revision-codigo";
const CODE_TITLE_ID = "revision-codigo-titulo";
const CODE_FIELD_ID = "revision-codigo";
const QUEUE_BLOCK_ID = "bloque-revision-cola";
const QUEUE_HEADING_ID = "revision-cola-titulo";
const PLAYER_HEADING_ID = "revision-video-titulo";
const CODE_PERMALINK = `${ROUTES.review}#${CODE_BLOCK_ID}`;
const QUEUE_PERMALINK = `${ROUTES.review}#${QUEUE_BLOCK_ID}`;

const FAILURES: Record<ReviewFailure, string> = {
  not_pending: text.notPending,
  incomplete: text.incomplete,
  practice_inactive: text.practiceInactive,
  level_inactive: text.levelInactive,
  videos_not_ready: text.videosNotReady,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

// Mux Player pesa: se descarga solo cuando hay algo que reproducir, y nunca en el servidor.
const Player = dynamic(() => import("./player").then((module) => module.Player), { ssr: false });

/** Lo que se ve en el lugar del reproductor. */
type VideoState =
  | { kind: "none" }
  | { kind: "loading"; lesson: LessonRow }
  | {
      kind: "playing";
      lesson: LessonRow;
      grant: Extract<VideoAnswer, { kind: "granted" }>;
      startTime: number;
      /** Ya se renovó una vez sin llegar a reproducirse: otra caducidad es un error. */
      renewed: boolean;
    }
  | { kind: "no_video"; lesson: LessonRow }
  | { kind: "failed"; lesson: LessonRow };

const subscribeNothing = () => () => undefined;
/** Verdadero solo ya montada en el navegador: sin JavaScript no hay con qué reproducir. */
const useMounted = () =>
  useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );

export interface ReviewScreenProps {
  /** La cola, ya puesta en palabras por la página. */
  view: ReviewView;
}

export function ReviewScreen({ view }: ReviewScreenProps) {
  const [code, codeAction, codePending] = useActionState(reviewCodeAction, CODE_IDLE, CODE_PERMALINK);
  const [queue, sendQueue, queuePending] = useActionState(approveAction, QUEUE_IDLE, QUEUE_PERMALINK);
  const mounted = useMounted();
  const [video, setVideo] = useState<VideoState>({ kind: "none" });
  // Cuál pedido manda: si se pulsa «Ver» en otra lección antes de que conteste el primero, el
  // primero ya no pinta nada.
  const ticket = useRef(0);
  const playerHeading = useRef<HTMLHeadingElement>(null);
  const watchedLesson = video.kind === "none" ? null : video.lesson.id;

  // El foco va al reproductor cuando se elige una lección: puede estar lejos, arriba de la cola.
  useEffect(() => {
    if (watchedLesson !== null) playerHeading.current?.focus();
  }, [watchedLesson]);

  async function watch(lesson: LessonRow, startTime = 0, renewed = false) {
    ticket.current += 1;
    const mine = ticket.current;
    if (!renewed) setVideo({ kind: "loading", lesson });
    let answer: VideoAnswer;
    try {
      answer = await lessonVideoAction(lesson.id);
    } catch {
      answer = { kind: "unavailable" };
    }
    if (mine !== ticket.current) return;
    if (answer.kind === "granted") setVideo({ kind: "playing", lesson, grant: answer, startTime, renewed });
    else if (answer.kind === "no_video") setVideo({ kind: "no_video", lesson });
    else setVideo({ kind: "failed", lesson });
  }

  function expired(at: number) {
    if (video.kind !== "playing") return;
    if (video.renewed) setVideo({ kind: "failed", lesson: video.lesson });
    else void watch(video.lesson, at, true);
  }

  const attempt = queue.kind === "idle" ? 0 : queue.attempt;
  const result: string | null = queuePending
    ? null
    : queue.kind === "approved"
      ? text.approved
      : queue.kind === "failed"
        ? // Si la página ya leyó un código reciente (se dio después), pedirlo ya no es cierto.
          queue.reason === "needs_code" && view.canChange
          ? null
          : FAILURES[queue.reason]
        : null;
  const tone = queue.kind === "approved" ? "success" : queue.kind === "failed" && (queue.reason === "unavailable" || queue.reason === "unknown") ? "danger" : "warning";
  const { block, answer, spoken } = useAnswerFocus(queuePending, attempt, result);

  const status =
    video.kind === "loading" ? text.loading : video.kind === "no_video" ? text.noVideo : video.kind === "failed" ? text.failed : null;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
      {!view.canChange && (
        <CodeBlock
          blockId={CODE_BLOCK_ID}
          titleId={CODE_TITLE_ID}
          fieldId={CODE_FIELD_ID}
          body={text.codeBody}
          notAvailable={text.codeNotAvailable}
          state={code}
          action={codeAction}
          pending={codePending}
        />
      )}

      {video.kind !== "none" && (
        <section aria-labelledby={PLAYER_HEADING_ID} className="flex flex-col gap-3">
          <h2 ref={playerHeading} id={PLAYER_HEADING_ID} tabIndex={-1} className="text-h3 outline-none">
            {t(text.watching, { title: video.lesson.title })}
          </h2>
          <p className="text-body-s text-text-2">{text.preview}</p>
          {video.kind === "playing" && (
            <Player
              key={`${video.lesson.id}-${video.grant.tokens.playback}`}
              playbackId={video.grant.playbackId}
              tokens={video.grant.tokens}
              startTime={video.startTime}
              onExpired={expired}
              onFailed={() => setVideo({ kind: "failed", lesson: video.lesson })}
              onPlaying={() => {
                if (video.renewed) setVideo({ ...video, renewed: false });
              }}
            />
          )}
          {video.kind === "failed" && (
            <div>
              <Button type="button" variant="secondary" size="md" onClick={() => void watch(video.lesson)}>
                {text.retry}
              </Button>
            </div>
          )}
        </section>
      )}
      {/* Existe desde antes: una región que nace con su texto no siempre se anuncia. */}
      <p role="status" className="text-body-s text-text-2">
        {status}
      </p>

      <section ref={block} id={QUEUE_BLOCK_ID} aria-labelledby={QUEUE_HEADING_ID} tabIndex={-1} className="flex flex-col gap-6 outline-none">
        <h2 id={QUEUE_HEADING_ID} className="text-h2">
          {text.queueTitle}
        </h2>
        <noscript>
          <p className="text-body-s text-text-2">{text.noScript}</p>
        </noscript>
        {!view.canChange && <p className="text-body-s text-text-2">{text.approveLocked}</p>}
        <BlockResult message={result} tone={tone} pending={queuePending} pendingText={text.working} answer={answer} spoken={spoken} />
        {view.courses.length === 0 ? (
          <p className="text-text-2">{text.empty}</p>
        ) : (
          <ol className="flex flex-col gap-6">
            {view.courses.map((course) => (
              <Course
                key={course.id}
                course={course}
                canChange={view.canChange}
                confirming={queue.kind === "confirming" && queue.course === course.id && !queuePending}
                action={sendQueue}
                pending={queuePending}
                mounted={mounted}
                watching={watchedLesson}
                onWatch={(lesson) => void watch(lesson)}
              />
            ))}
          </ol>
        )}
      </section>

      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}

interface CourseProps {
  course: CourseRow;
  canChange: boolean;
  /** Se está preguntando si se aprueba este curso. */
  confirming: boolean;
  action: (form: FormData) => void;
  pending: boolean;
  mounted: boolean;
  /** La lección que está en el reproductor. */
  watching: string | null;
  onWatch: (lesson: LessonRow) => void;
}

function Course({ course, canChange, confirming, action, pending, mounted, watching, onWatch }: CourseProps) {
  const headingId = `revision-curso-${course.id}`;
  return (
    <li>
      <article aria-labelledby={headingId} className="flex flex-col gap-4 rounded-md border border-border p-4">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-h3 break-words">
            {course.title}
          </h3>
          <p className="text-text-2">{course.teacher}</p>
          <p className="text-body-s text-text-2">{course.practiceAndLevel}</p>
          <p className="text-body-s text-text-2">{course.lessons}</p>
          <p className="text-body-s text-text-2">{course.loaded}</p>
        </div>

        {course.modules.map((part, index) => (
          <section key={`${index}-${part.title}`} className="flex flex-col gap-2">
            <h4 className="text-body font-semibold break-words">{part.title}</h4>
            <ol className="flex flex-col gap-2">
              {part.lessons.map((lesson) => (
                <li key={lesson.id} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 break-words">{lesson.title}</span>
                  <span className="text-body-s text-text-2">{lesson.length}</span>
                  {lesson.playable ? (
                    mounted && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="md"
                        disabled={watching === lesson.id}
                        onClick={() => onWatch(lesson)}
                      >
                        {text.watch}
                        {SPACE}
                        <span className="sr-only">{lesson.detail}</span>
                      </Button>
                    )
                  ) : (
                    <span className="text-body-s text-text-2">{lesson.status}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}

        {canChange && (
          <form action={action} noValidate className="flex flex-col gap-3">
            {confirming ? (
              <>
                <p className="font-semibold">{text.confirmTitle}</p>
                <p className="text-text-2">{text.confirmBody}</p>
                {course.firstOfTeacher !== null && <p className="text-text-2">{course.firstOfTeacher}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" name="do" value={course.buttons.confirm} size="md" loading={pending} loadingLabel={text.working}>
                    {text.confirm}
                  </Button>
                  <Button type="submit" name="do" value="cancel" variant="secondary" size="md" disabled={pending}>
                    {text.cancel}
                  </Button>
                </div>
              </>
            ) : (
              <div>
                <Button type="submit" name="do" value={course.buttons.ask} size="md" disabled={pending}>
                  {text.approve}
                  {SPACE}
                  <span className="sr-only">{t(text.watchOf, { title: course.title })}</span>
                </Button>
              </div>
            )}
          </form>
        )}
      </article>
    </li>
  );
}
