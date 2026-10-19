"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { PlayerProps } from "@/app/_video/player";
import { lesson as text } from "@/messages/es/lesson";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { Disclaimer } from "@/ui/disclaimer";
import { LessonRow } from "@/ui/lesson-row";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { Tabs } from "@/ui/tabs";
import { TextLink } from "@/ui/text-link";

import { rememberCaptionsAction, watchLessonAction } from "./actions";
import type { Denial, InitialState, WatchAnswer } from "./outcomes";

// La pantalla de una lección (PA-22, T-203; diseño, sección 6.2). En escritorio, dos columnas:
// el reproductor, el título y «Sobre esta lección» a la izquierda, y el temario a la derecha. En
// teléfono, el reproductor arriba, pegado al desplazar, y debajo las pestañas Temario y Sobre
// esta lección. Las pestañas de Recursos y Comentarios no aparecen hasta su tarea (T-404,
// T-501; decisión de Sergio del 2026-10-15), y con una sola, en escritorio, va como sección.
//
// El reproductor pide su dirección con la acción después de pintar (RF-305), y se descarga
// solo entonces. Lo que se ve en su lugar lo decide la tabla (`outcomes.ts`). Arranca con los
// subtítulos como la cuenta los dejó, y si la persona los enciende o los apaga, se recuerda en
// la cuenta (RF-310) y en la pantalla: una dirección renovada sigue con lo que eligió. Renovar
// no vuelve a montar el reproductor (sin `key`): le pasa otra concesión, y así no se sale de la
// pantalla completa.

/** Una lección del temario, ya en palabras y con su dirección. */
export interface SyllabusEntry {
  id: string;
  number: number;
  title: string;
  duration: string;
  current: boolean;
  href: string;
}

export interface LessonScreenProps {
  slug: string;
  lessonId: string;
  heading: string;
  byline: string;
  summary: string | null;
  about: string;
  modules: { id: string; title: string; lessons: SyllabusEntry[] }[];
  next: { title: string; href: string } | null;
  initial: Exclude<InitialState, { kind: "suspended" | "reload" }>;
  /** Si la cuenta dejó los subtítulos encendidos. */
  captions: boolean;
}

/** Si el reproductor no se pudo descargar: se dice como cualquier otro error, con «Reintentar». */
function PlayerMissing({ onFailed }: PlayerProps) {
  useEffect(() => onFailed(), [onFailed]);
  return null;
}

// Mux Player pesa: se descarga solo cuando hay algo que reproducir, y nunca en el servidor.
const Player = dynamic(() => import("@/app/_video/player").then((module) => module.Player, () => PlayerMissing), {
  ssr: false,
  loading: () => <p className="p-6 text-body-s text-text-2">{text.player.loading}</p>,
});

/** Lo que se ve en el lugar del reproductor. */
type VideoState =
  | { kind: "poster" }
  | { kind: "loading" }
  | {
      kind: "playing";
      grant: Extract<WatchAnswer, { kind: "granted" }>;
      /** Qué pedido la dio: con una dirección renovada, el reproductor monta otro Mux Player sin salir de la pantalla completa. */
      grantNumber: number;
      startTime: number;
      /** Ya se renovó una vez sin llegar a reproducirse: otra caducidad es un error. */
      renewed: boolean;
      /** Se está pidiendo la dirección nueva: otro aviso de caducidad no pide otra. */
      renewing: boolean;
    }
  | { kind: "ended" }
  | { kind: "failed" }
  | { kind: "denied"; denial: Denial }
  | { kind: "no_video" }
  | { kind: "unavailable" };

const subscribeNothing = () => () => undefined;
/** Verdadero solo ya montada en el navegador: sin JavaScript no hay con qué reproducir. */
const useMounted = () =>
  useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );

function stateOf(initial: LessonScreenProps["initial"]): VideoState {
  return initial.kind === "ready" ? { kind: "poster" } : initial;
}

/** Si el foco quedó sin dueño: el elemento que lo tenía se fue de la página. */
function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** Una redirección de Next, que una acción de servidor lanza al navegador: no es un error. */
function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/** El título de PA-33 y su frase, por motivo. */
function paywallCopy(denial: Denial): [string, string] {
  const copy = text.denied;
  if (denial.reason === "never_subscribed") return [copy.neverSubscribed, copy.neverSubscribedText];
  if (denial.reason === "refunded") return [copy.refunded, copy.refundedText];
  return [t(copy.ended, { date: denial.date }), denial.reason === "expired" ? copy.expiredText : copy.graceEndedText];
}

/** Lo que se le dice a quien no ve el lugar del reproductor, cuando cambia. */
function announcementOf(video: VideoState): string {
  switch (video.kind) {
    case "ended":
      return text.player.ended;
    case "failed":
      return text.player.failed;
    case "no_video":
      return text.player.noVideo;
    case "unavailable":
      return text.player.unavailable;
    case "denied":
      return paywallCopy(video.denial).join(" ");
    default:
      return "";
  }
}

/** PA-33: por qué no hay acceso, en el lugar del reproductor. Sin «Ver planes» hasta que exista la pantalla (T-30x). */
function Paywall({ denial }: { denial: Denial }) {
  const [title, sentence] = paywallCopy(denial);
  return (
    <div className="flex h-full flex-col justify-center gap-2 p-6">
      <h2 className="text-h3">{title}</h2>
      <p className="text-text-2">{sentence}</p>
    </div>
  );
}

export function LessonScreen({ slug, lessonId, heading, byline, summary, about, modules, next, initial, captions }: LessonScreenProps) {
  const mounted = useMounted();
  const [video, setVideo] = useState<VideoState>(() => stateOf(initial));
  const [captionsOn, setCaptionsOn] = useState(captions);
  // Cuál pedido manda: uno que contesta tarde, después de un error o de otro pedido, ya no pinta.
  const ticket = useRef(0);
  const area = useRef<HTMLDivElement>(null);
  // Cuando lo que tenía el foco se va (el reproductor al terminar o al fallar), el foco se queda
  // en el lugar del reproductor y no cae al documento.
  useEffect(() => {
    if (video.kind !== "playing" && video.kind !== "poster" && focusIsLost()) area.current?.focus();
  }, [video.kind]);

  async function watch(startTime = 0, renewed = false) {
    ticket.current += 1;
    const mine = ticket.current;
    if (!renewed) {
      setVideo({ kind: "loading" });
      // El botón pulsado se va: el foco se queda en el lugar del reproductor.
      area.current?.focus();
    }
    let answer: WatchAnswer;
    try {
      answer = await watchLessonAction(slug, lessonId);
    } catch (error) {
      // La acción manda a la página cuando la sesión ya no pasa: Next navega solo, y no es «algo falló».
      if (isRedirect(error)) return;
      answer = { kind: "unavailable" };
    }
    if (mine !== ticket.current) return;
    if (answer.kind === "granted") setVideo({ kind: "playing", grant: answer, grantNumber: mine, startTime, renewed, renewing: false });
    else setVideo(answer);
  }

  function expired(at: number) {
    if (video.kind !== "playing" || video.renewing) return;
    if (video.renewed) setVideo({ kind: "failed" });
    else {
      setVideo({ ...video, renewing: true });
      void watch(at, true);
    }
  }

  /** La persona encendió o apagó los subtítulos: se recuerda. Si no se guardó, el video sigue igual. */
  function captionsChanged(on: boolean) {
    setCaptionsOn(on);
    rememberCaptionsAction(on).catch(() => undefined);
  }

  function failed() {
    // Una renovación en camino ya no pinta nada: manda el error.
    ticket.current += 1;
    setVideo({ kind: "failed" });
  }

  // El temario va dos veces en la página (la columna de escritorio y la pestaña del teléfono;
  // una de las dos, oculta): cada una con sus propios `id`. En la columna, sus módulos van bajo
  // el título «Temario» (h3); en la pestaña no hay título de por medio, y van después del h1 (h2).
  const syllabus = (prefix: string, Heading: "h2" | "h3") => (
    <div className="flex flex-col gap-4">
      {modules.map((group) => (
        <div key={group.id} className="flex flex-col gap-1">
          <Heading id={`${prefix}-${group.id}`} className="text-label uppercase text-text-3">
            {group.title}
          </Heading>
          <ul aria-labelledby={`${prefix}-${group.id}`} className="flex flex-col">
            {group.lessons.map((lesson) => (
              <li key={lesson.id}>
                <LessonRow href={lesson.href} number={lesson.number} title={lesson.title} duration={lesson.duration} current={lesson.current} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
  const aboutPanel = (
    <div className="flex flex-col gap-2 text-text-2">
      {summary !== null && <p>{summary}</p>}
      <p>{about}</p>
    </div>
  );

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-6 px-4 py-6 outline-none">
      <BackLink href={ROUTES.home}>{text.back}</BackLink>
      <div className="grid gap-8 lg:grid-cols-10">
        <div className="flex flex-col gap-4 lg:col-span-7">
          <section aria-label={text.player.label} className="sticky top-0 z-(--z-sticky) lg:static">
            <div ref={area} tabIndex={-1} className="flex aspect-video w-full flex-col bg-player outline-none">
              {video.kind === "playing" ? (
                <Player
                  grant={video.grantNumber}
                  playbackId={video.grant.playbackId}
                  tokens={video.grant.tokens}
                  startTime={video.startTime}
                  speeds={video.grant.speeds}
                  watermark={video.grant.watermark}
                  captions={captionsOn}
                  onCaptionsChange={captionsChanged}
                  onExpired={expired}
                  onFailed={failed}
                  onPlaying={() => {
                    if (video.renewed) setVideo({ ...video, renewed: false });
                  }}
                  onEnded={() => setVideo({ kind: "ended" })}
                />
              ) : video.kind === "denied" ? (
                <Paywall denial={video.denial} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                  {video.kind === "poster" &&
                    (mounted ? (
                      <Button type="button" onClick={() => void watch()}>
                        {text.player.play}
                      </Button>
                    ) : (
                      // Hasta que la página se monta. Dentro de `<noscript>` React no lo pinta
                      // (medido sin JavaScript), así que con él se ve un instante al cargar.
                      <p className="text-text-2">{text.player.noScript}</p>
                    ))}
                  {video.kind === "loading" && <p className="text-text-2">{text.player.loading}</p>}
                  {video.kind === "no_video" && <p className="text-text-2">{text.player.noVideo}</p>}
                  {(video.kind === "failed" || video.kind === "unavailable") && (
                    <>
                      <p className="text-text-2">{video.kind === "failed" ? text.player.failed : text.player.unavailable}</p>
                      <Button type="button" variant="secondary" onClick={() => void watch()}>
                        {text.player.retry}
                      </Button>
                    </>
                  )}
                  {video.kind === "ended" && (
                    <>
                      <p className="text-h3">{text.player.ended}</p>
                      {next !== null && <TextLink href={next.href}>{t(text.player.next, { title: next.title })}</TextLink>}
                      <Button type="button" variant="secondary" onClick={() => void watch()}>
                        {text.player.replay}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
            {/* Lo que el reproductor dice a quien no lo ve: existe desde antes, para que se anuncie. */}
            <p role="status" className="sr-only">
              {announcementOf(video)}
            </p>
          </section>
          <div className="flex flex-col gap-1">
            <h1 className="text-h2">{heading}</h1>
            <p className="text-body-s text-text-2">{byline}</p>
          </div>
          <section aria-labelledby="sobre-esta-leccion" className="hidden flex-col gap-3 lg:flex">
            <h2 id="sobre-esta-leccion" className="text-h3">
              {text.about}
            </h2>
            {aboutPanel}
          </section>
          <div className="lg:hidden">
            <Tabs
              label={text.tabsLabel}
              idPrefix="leccion"
              items={[
                { id: "temario", label: text.syllabus, panel: syllabus("pestana-modulo", "h2"), hasFocusableContent: true },
                { id: "sobre", label: text.about, panel: aboutPanel },
              ]}
            />
          </div>
        </div>
        <aside aria-labelledby="temario" className="hidden flex-col gap-3 lg:col-span-3 lg:flex">
          <h2 id="temario" className="text-h3">
            {text.syllabus}
          </h2>
          {syllabus("columna-modulo", "h3")}
        </aside>
      </div>
      <Disclaimer />
    </main>
  );
}
