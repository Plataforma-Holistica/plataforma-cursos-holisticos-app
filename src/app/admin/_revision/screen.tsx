"use client";

import dynamic from "next/dynamic";
import { type RefObject, useActionState, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ResourceList } from "@/app/_catalog/resources/resource-list";
import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { Textarea } from "@/ui/textarea";
import { TextLink } from "@/ui/text-link";

import type { PlayerProps } from "@/app/_video/player";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { approveAction, lessonVideoAction, returnAction, reviewCodeAction, reviewResourceAction, reviewVideoAction } from "./actions";
import { RETURN_FIX_FIELD, RETURN_MAX, RETURN_REASON_FIELD, returnButton, type CodeState, type ReturnFailure, type ReturnProblem, type ReturnState, type ReviewFailure, type ReviewState, type VideoAnswer } from "./outcomes";
import type { CourseRow, LessonRow, ReviewView, SubmissionRow } from "./rows";

// PA-61 y PA-62 mínimas · Los cursos por revisar, en una sola pantalla (decisión de Sergio del
// 2026-10-14): la cola, las lecciones de cada curso, el reproductor y aprobar. Desde T-405, lo enviado por
// el portal: sus recursos, el anexo aceptado y devolver con motivo y qué corregir. Las notas y la lista del
// revisor llegan con T-406.
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
const RETURN_IDLE: ReturnState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const CODE_BLOCK_ID = "bloque-revision-codigo";
const CODE_TITLE_ID = "revision-codigo-titulo";
const CODE_FIELD_ID = "revision-codigo";
const QUEUE_BLOCK_ID = "bloque-revision-cola";
const QUEUE_HEADING_ID = "revision-cola-titulo";
const PLAYER_HEADING_ID = "revision-video-titulo";
const PLAYER_CONTEXT_ID = "revision-video-curso";
const CODE_PERMALINK = `${ROUTES.review}#${CODE_BLOCK_ID}`;
const QUEUE_PERMALINK = `${ROUTES.review}#${QUEUE_BLOCK_ID}`;

const FAILURES: Record<ReviewFailure, string> = {
  not_pending: text.notPending,
  self: t(text.self),
  incomplete: text.incomplete,
  practice_inactive: text.practiceInactive,
  level_inactive: text.levelInactive,
  videos_not_ready: text.videosNotReady,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

const RETURN_FAILURES: Record<ReturnFailure, string> = {
  not_pending: text.notPending,
  changed: text.returnChanged,
  self: t(text.returnSelf),
  invalid: text.returnInvalid,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.returnUnknown,
};

/** Lo que se dice en un campo. Vacío dice cuál falta. */
const problemText = (problem: ReturnProblem | null, empty: string): string | undefined => {
  if (problem === null) return undefined;
  if (problem === "empty") return empty;
  return problem === "too_long" ? t(text.returnTooLong, { max: String(RETURN_MAX) }) : text.returnInvalid;
};

/** Si el reproductor no se pudo descargar: se dice como cualquier otro error, con «Reintentar». */
function PlayerMissing({ onFailed }: PlayerProps) {
  useEffect(() => onFailed(), [onFailed]);
  return null;
}

// Mux Player pesa: se descarga solo cuando hay algo que reproducir, y nunca en el servidor.
const Player = dynamic(() => import("@/app/_video/player").then((module) => module.Player, () => PlayerMissing), {
  ssr: false,
  loading: () => <p className="text-body-s text-text-2">{text.loading}</p>,
});

/** Lo que se ve en el lugar del reproductor. */
type VideoState =
  | { kind: "none" }
  | { kind: "loading"; lesson: LessonRow }
  | {
      kind: "playing";
      lesson: LessonRow;
      grant: Extract<VideoAnswer, { kind: "granted" }>;
      /** Qué pedido la dio: con una dirección renovada, el reproductor monta otro Mux Player sin salir de la pantalla completa. */
      grantNumber: number;
      startTime: number;
      /** Ya se renovó una vez sin llegar a reproducirse: otra caducidad es un error. */
      renewed: boolean;
      /** Se está pidiendo la dirección nueva: otro aviso de caducidad no pide otra. */
      renewing: boolean;
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
  /** La página llegó con el aviso de que se aprobó un curso. */
  published?: boolean;
  /** O de que se devolvió uno. */
  returned?: boolean;
}

export function ReviewScreen({ view, published = false, returned = false }: ReviewScreenProps) {
  const [code, codeAction, codePending] = useActionState(reviewCodeAction, CODE_IDLE, CODE_PERMALINK);
  const [queue, sendQueue, queuePending] = useActionState(approveAction, QUEUE_IDLE, QUEUE_PERMALINK);
  // Vive aquí y no en la tarjeta: con la respuesta, el curso puede irse de la cola o traer otro envío, y lo que contestó (y lo escrito) no se va con él.
  const [returning, sendReturn, returnPending] = useActionState(returnAction, RETURN_IDLE, QUEUE_PERMALINK);
  const mounted = useMounted();
  const [video, setVideo] = useState<VideoState>({ kind: "none" });
  // Cuál pedido manda: si se pulsa «Ver» en otra lección antes de que conteste el primero, el
  // primero ya no pinta nada.
  const ticket = useRef(0);
  const playerHeading = useRef<HTMLHeadingElement>(null);
  const publishedBox = useRef<HTMLDivElement>(null);
  // Cada «Ver» y cada «Reintentar» llevan el foco al reproductor, aunque sea la misma lección:
  // el botón pulsado queda inactivo o desaparece.
  const [focusRequest, setFocusRequest] = useState(0);
  const watchedLesson = video.kind === "none" ? null : video.lesson.id;

  // El foco va al reproductor cuando se elige una lección: puede estar lejos, arriba de la cola.
  useEffect(() => {
    if (focusRequest > 0) playerHeading.current?.focus();
  }, [focusRequest]);

  // Si el reproductor tenía el foco y se fue con un error, el foco no se queda en el documento.
  useEffect(() => {
    if ((video.kind === "failed" || video.kind === "no_video") && focusIsLost()) playerHeading.current?.focus();
  }, [video.kind]);

  // Llegó con el aviso de aprobado: si el foco quedó sin dueño (el botón pulsado se fue con su
  // curso), lo toma el aviso.
  useEffect(() => {
    if ((published || returned) && focusIsLost()) publishedBox.current?.focus();
  }, [published, returned]);

  async function watch(lesson: LessonRow, startTime = 0, renewed = false) {
    ticket.current += 1;
    const mine = ticket.current;
    if (!renewed) {
      setVideo({ kind: "loading", lesson });
      setFocusRequest((count) => count + 1);
    }
    let answer: VideoAnswer;
    try {
      answer = lesson.draftCourse === null ? await lessonVideoAction(lesson.id) : await reviewVideoAction(lesson.draftCourse, lesson.id);
    } catch {
      answer = { kind: "unavailable" };
    }
    if (mine !== ticket.current) return;
    if (answer.kind === "granted") setVideo({ kind: "playing", lesson, grant: answer, grantNumber: mine, startTime, renewed, renewing: false });
    else if (answer.kind === "no_video") setVideo({ kind: "no_video", lesson });
    else setVideo({ kind: "failed", lesson });
  }

  function expired(at: number) {
    if (video.kind !== "playing" || video.renewing) return;
    if (video.renewed) setVideo({ kind: "failed", lesson: video.lesson });
    else {
      setVideo({ ...video, renewing: true });
      void watch(video.lesson, at, true);
    }
  }

  function failed(lesson: LessonRow) {
    // Una renovación en camino ya no pinta nada: manda el error.
    ticket.current += 1;
    setVideo({ kind: "failed", lesson });
  }

  const attempt = queue.kind === "idle" ? 0 : queue.attempt;
  const result: string | null =
    queuePending || queue.kind !== "failed" || returning.kind === "open"
      ? null
      : // Si la página ya leyó un código reciente (se dio después), pedirlo ya no es cierto.
        queue.reason === "needs_code" && view.canChange
        ? null
        : FAILURES[queue.reason];
  const tone = queue.kind === "failed" && (queue.reason === "unavailable" || queue.reason === "unknown") ? "danger" : "warning";
  const { block, answer, spoken } = useAnswerFocus(queuePending, attempt, result);

  const returnOpen = returning.kind === "open" ? returning : null;
  const returnHasProblems = returnOpen !== null && (returnOpen.problems.reason !== null || returnOpen.problems.whatToFix !== null);
  // Si la página ya leyó un código reciente, pedirlo ya no es cierto: lo escrito sigue, listo para enviar.
  const returnFailure = returnOpen === null || returnOpen.failure === null || (returnOpen.failure === "needs_code" && view.canChange) ? null : RETURN_FAILURES[returnOpen.failure];
  // Sigue en la cola: se contesta dentro de su tarjeta. Si se fue, arriba de la cola, porque ya no hay dónde.
  const returnCourse = returning.kind === "idle" ? null : returning.course;
  const returnRow = returnCourse === null ? undefined : view.teachers.flatMap((teacher) => teacher.courses).find((course) => course.id === returnCourse && course.submission !== null);
  const returnHere = returnOpen !== null && returnRow !== undefined;
  // Lo que se dice, en este orden: no se supo (pudo haberse devuelto), el curso se fue, el envío que se veía cambió, y lo que contestó el último envío.
  const returnGone = returnOpen !== null && returnRow === undefined;
  const returnChanged = returnOpen !== null && returnRow?.submission !== null && returnRow?.submission !== undefined && returnRow.submission.id !== returnOpen.submission;
  const returnUnknown = returnOpen?.failure === "unknown" || returnOpen?.failure === "unavailable";
  const returnSaid = returnUnknown ? returnFailure : returnGone ? text.notPending : returnChanged ? text.returnChanged : returnHasProblems ? text.returnProblems : returnFailure;
  const returnResult = returnPending ? null : returnSaid;
  const { block: returnBlock, answer: returnAnswer, spoken: returnSpoken } = useAnswerFocus(returnPending, returnOpen?.attempt ?? 0, returnResult);

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
          {/* Al llegar el foco se anuncia también de qué curso es. */}
          <h2 ref={playerHeading} id={PLAYER_HEADING_ID} tabIndex={-1} aria-describedby={PLAYER_CONTEXT_ID} className="text-h3 outline-none">
            {t(text.watching, { title: video.lesson.title })}
          </h2>
          <p id={PLAYER_CONTEXT_ID} className="text-text-2">
            {video.lesson.context}
          </p>
          <p className="text-body-s text-text-2">{text.preview}</p>
          {video.kind === "playing" && (
            <Player
              grant={video.grantNumber}
              playbackId={video.grant.playbackId}
              tokens={video.grant.tokens}
              startTime={video.startTime}
              speeds={video.grant.speeds}
              watermark={video.grant.watermark}
              onExpired={expired}
              onFailed={() => failed(video.lesson)}
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
        {/* Lo pinta el servidor y se va al montar: sin JavaScript se queda. No es un
            `<noscript>`: hay navegadores que lo tratan como texto aunque no corran nada. */}
        {!mounted && <p className="text-body-s text-text-2">{text.noScript}</p>}
        {!view.canChange && <p className="text-body-s text-text-2">{text.approveLocked}</p>}
        {(published || returned) && (
          <div ref={publishedBox} tabIndex={-1} className="outline-none">
            <InlineAlert tone="success">{published ? text.approved : t(text.returned)}</InlineAlert>
          </div>
        )}
        <BlockResult message={result} tone={tone} pending={queuePending} pendingText={text.working} answer={answer} spoken={spoken} />
        {returnGone && (
          <div className="flex flex-col gap-3">
            <BlockResult message={returnResult} tone="warning" pending={false} pendingText="" answer={returnAnswer} spoken={returnSpoken} />
            {(returnOpen.reason !== "" || returnOpen.whatToFix !== "") && (
              <div className="flex flex-col gap-1">
                <p className="text-body-s font-semibold">{text.returnWritten}</p>
                <p className="whitespace-pre-line break-words text-body-s text-text-2">{returnOpen.reason}</p>
                <p className="whitespace-pre-line break-words text-body-s text-text-2">{returnOpen.whatToFix}</p>
              </div>
            )}
            <form action={sendReturn}>
              <Button type="submit" name="do" value={returnButton.cancel(returnOpen.course)} variant="secondary" size="md" disabled={returnPending}>
                {text.returnDismiss}
              </Button>
            </form>
          </div>
        )}
        {/* El foco de «Cerrar este aviso», cuando el curso ya no está. Con el curso en la cola, lo toma su bloque. */}
        <section ref={returnRow === undefined ? returnBlock : undefined} tabIndex={-1} className="flex flex-col gap-6 outline-none">
        {view.teachers.length === 0 ? (
          <p className="text-text-2">{text.empty}</p>
        ) : (
          view.teachers.map((teacher) => (
            <div key={teacher.name} className="flex flex-col gap-4">
              <h3 className="text-h3 break-words">{teacher.name}</h3>
              <ol className="flex flex-col gap-6">
                {teacher.courses.map((course) => (
                  <Course
                    key={course.id}
                    course={course}
                    canChange={view.canChange}
                    confirming={queue.kind === "confirming" && queue.course === course.id}
                    answer={answer}
                    action={sendQueue}
                    pending={queuePending}
                    mounted={mounted}
                    watching={watchedLesson}
                    onWatch={(lesson) => void watch(lesson)}
                    returning={{
                      open: returnOpen?.course === course.id ? returnOpen : null,
                      lastHere: returnCourse === course.id,
                      // Con otro curso abierto no se ofrece: abrir este se llevaría lo escrito en aquel.
                      mayOpen: !returnHere,
                      action: sendReturn,
                      pending: returnPending,
                      result: returnResult,
                    }}
                    returnBlock={returnBlock}
                    returnAnswer={returnAnswer}
                    returnSpoken={returnSpoken}
                  />
                ))}
              </ol>
            </div>
          ))
        )}
        </section>
      </section>

      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}

/** El foco no tiene dueño: quedó en el documento. */
function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

interface CourseProps {
  course: CourseRow;
  canChange: boolean;
  /** Se está preguntando si se aprueba este curso. */
  confirming: boolean;
  /** Dónde va el foco cuando llega la pregunta: el botón pulsado desaparece con ella. */
  answer: RefObject<HTMLDivElement | null>;
  action: (form: FormData) => void;
  pending: boolean;
  mounted: boolean;
  /** La lección que está en el reproductor. */
  watching: string | null;
  onWatch: (lesson: LessonRow) => void;
  returning: Returning;
  returnBlock: RefObject<HTMLElement | null>;
  returnAnswer: RefObject<HTMLDivElement | null>;
  returnSpoken: RefObject<HTMLSpanElement | null>;
}

function Course({ course, canChange, confirming, answer, action, pending, mounted, watching, onWatch, returning, returnBlock, returnAnswer, returnSpoken }: CourseProps) {
  const headingId = `revision-curso-${course.id}`;
  return (
    <li>
      <article aria-labelledby={headingId} className="flex flex-col gap-4 rounded-md border border-border p-4">
        <div className="flex flex-col gap-1">
          <h4 id={headingId} className="text-body-l font-semibold break-words">
            {course.title}
          </h4>
          <p className="text-body-s text-text-2">{course.practiceAndLevel}</p>
          <p className="text-body-s text-text-2">{course.lessons}</p>
          <p className="text-body-s text-text-2">{course.loaded}</p>
          {course.summary !== null && <p className="whitespace-pre-line break-words text-text-2">{course.summary}</p>}
        </div>

        {course.modules.map((part) => (
          <section key={part.id} className="flex flex-col gap-2">
            <h5 className="text-body font-semibold break-words">{part.title}</h5>
            <ol className="flex flex-col gap-2">
              {part.lessons.map((lesson) => (
                <li key={lesson.id} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 break-words">{lesson.title}</span>
                  <span className="text-body-s text-text-2">{lesson.length}</span>
                  {watching === lesson.id && <span className="text-body-s font-semibold">{text.watchingNow}</span>}
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
                  {lesson.description !== null && <p className="w-full whitespace-pre-line break-words text-body-s text-text-2">{lesson.description}</p>}
                  {lesson.resources.length > 0 && (
                    <div className="w-full">
                      <p className="text-body-s font-semibold">{text.lessonResources}</p>
                      <ResourceList items={lesson.resources} canDownload action={reviewResourceAction} permalink={QUEUE_PERMALINK} />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}

        {course.submission !== null && <Submitted submission={course.submission} />}
        {course.submission !== null && <ReturnBlock course={course} submission={course.submission} canChange={canChange} returning={returning} block={returnBlock} answer={returnAnswer} spoken={returnSpoken} />}
        {course.submission === null && canChange && !returning.mayOpen && <p className="text-body-s text-text-2">{text.returnOneAtATime}</p>}
        {course.submission === null && canChange && returning.mayOpen && (
          <form action={action} noValidate className="flex flex-col gap-3">
            {confirming ? (
              <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
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
              </div>
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

/** Lo que el curso trae por haberse enviado: sus recursos y el anexo aceptado (PA-62). */
function Submitted({ submission }: { submission: SubmissionRow }) {
  return (
    <>
      {submission.resources.length > 0 && (
        <section className="flex flex-col gap-2">
          <h5 className="text-body font-semibold">{text.courseResources}</h5>
          <ResourceList items={submission.resources} canDownload action={reviewResourceAction} permalink={QUEUE_PERMALINK} />
        </section>
      )}
      <section className="flex flex-col gap-1">
        <h5 className="text-body font-semibold">{text.annexTitle}</h5>
        <p className="text-body-s text-text-2">{submission.annex}</p>
        <p className="break-words text-body-s text-text-2">{submission.statement}</p>
      </section>
      <p className="text-body-s text-text-2">{text.approveLater}</p>
    </>
  );
}

/** Lo que el bloque de devolver de una tarjeta recibe de la pantalla, que es donde vive su estado. */
interface Returning {
  /** Lo abierto, si es este curso. */
  open: Extract<ReturnState, { kind: "open" }> | null;
  /** Fue este el último curso que se abrió: el foco vuelve aquí al cancelar. */
  lastHere: boolean;
  mayOpen: boolean;
  action: (form: FormData) => void;
  pending: boolean;
  result: string | null;
}

interface ReturnBlockProps {
  course: CourseRow;
  submission: SubmissionRow;
  canChange: boolean;
  returning: Returning;
  block: RefObject<HTMLElement | null>;
  answer: RefObject<HTMLDivElement | null>;
  spoken: RefObject<HTMLSpanElement | null>;
}

/**
 * Devolver al maestro, en dos pasos dentro del curso. Se ofrece solo con el código reciente, como aprobar; con algo ya escrito se queda a la vista, para no perderlo. Enviar lleva el envío que
 * se estaba viendo, nunca el de ahora: si cambió, no se ofrece enviar hasta que quien revisa pide seguir con el de ahora.
 */
function ReturnBlock({ course, submission, canChange, returning, block, answer, spoken }: ReturnBlockProps) {
  const { open, action, pending, result, lastHere } = returning;
  const changed = open !== null && open.submission !== submission.id;
  const fieldId = (name: string) => `revision-devolver-${name}-${course.id}`;

  if (open === null && !canChange) {
    return (
      <section ref={lastHere ? block : undefined} tabIndex={-1} aria-label={text.returnTitle} className="outline-none">
        <p className="text-body-s text-text-2">{t(text.returnLocked)}</p>
      </section>
    );
  }
  if (open === null && !returning.mayOpen) return <p className="text-body-s text-text-2">{text.returnOneAtATime}</p>;
  return (
    <section ref={lastHere ? block : undefined} tabIndex={-1} aria-label={text.returnTitle} className="flex flex-col gap-3 outline-none">
      {open !== null && <BlockResult message={result} tone="warning" pending={pending} pendingText={text.returnWorking} answer={answer} spoken={spoken} />}
      <form action={action} noValidate className="flex flex-col gap-3">
        {open === null ? (
          <div>
            <Button type="submit" name="do" value={submission.ask} variant="secondary" size="md" disabled={pending}>
              {t(text.returnOpen)}
              {SPACE}
              <span className="sr-only">{t(text.watchOf, { title: course.title })}</span>
            </Button>
          </div>
        ) : (
          // Con un envío en camino no toma el foco: al llegar la respuesta contaría como que la persona se fue.
          <div ref={result === null && !pending ? answer : undefined} tabIndex={-1} className="flex flex-col gap-3 outline-none">
            <p className="font-semibold">{text.returnTitle}</p>
            <p className="text-text-2">{t(text.returnBody)}</p>
            {!canChange && <p className="font-medium">{text.returnCopyFirst}</p>}
            {/* Arriba de los campos, lejos de enviar: el segundo clic de un doble clic no debe caer en algo que no se deshace. */}
            {changed && (
              <div>
                <Button type="submit" name="do" value={submission.ask} variant="secondary" size="md" disabled={pending}>
                  {text.returnContinue}
                </Button>
              </div>
            )}
            <Textarea
              id={fieldId("motivo")}
              name={RETURN_REASON_FIELD}
              label={text.returnReason}
              hint={text.returnReasonHint}
              defaultValue={open.reason}
              error={problemText(open.problems.reason, text.returnEmptyReason)}
              maxLength={RETURN_MAX}
              rows={4}
              readOnly={pending}
            />
            <Textarea
              id={fieldId("corregir")}
              name={RETURN_FIX_FIELD}
              label={text.returnFix}
              hint={text.returnFixHint}
              defaultValue={open.whatToFix}
              error={problemText(open.problems.whatToFix, text.returnEmptyFix)}
              maxLength={RETURN_MAX}
              rows={4}
              readOnly={pending}
            />
            <div className="flex flex-wrap gap-2">
              {!changed && (
                <Button type="submit" name="do" value={returnButton.send(course.id, open.submission)} size="md" loading={pending} loadingLabel={text.returnWorking}>
                  {text.returnSend}
                </Button>
              )}
              <Button type="submit" name="do" value={returnButton.cancel(course.id)} variant="secondary" size="md" disabled={pending}>
                {text.cancel}
              </Button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}
