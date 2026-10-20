"use client";

// El español de los controles: media-chrome, sobre el que está hecho Mux Player, solo trae el
// inglés registrado. Se registra su español con los nombres del diseño encima, como `es-MX`
// (registrar un idioma reemplaza su diccionario entero, no lo mezcla), y el idioma queda fijo.
import { Es } from "media-chrome/dist/lang/es.js";
import { addTranslation, setLanguage } from "media-chrome/dist/utils/i18n.js";
import MuxPlayer, { type MuxPlayerRefAttributes } from "@mux/mux-player-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { player as text } from "@/messages/es/player";
import { cx } from "@/ui/cx";

import { TOKEN_EXPIRED } from "./errors";
import { controlLabels, SEEK_SECONDS } from "./labels";
import { Watermark, watermarkIntact } from "./watermark";

// El reproductor (diseño, sección 5.4; RF-305, RF-312; T-108 y T-203). Es el único archivo que
// importa Mux Player, y las pantallas lo cargan con `next/dynamic` cuando hay algo que
// reproducir: así no viaja con la página. Una prueba de arquitectura y el lint lo exigen. Lo
// usan la pantalla de revisión y, con marca de agua, la de la lección.
//
// Va dentro de un contenedor propio, y ese contenedor es el que entra a pantalla completa
// (`fullscreenElement`, asignado por propiedad: como atributo, Mux lo busca por id antes de
// que el nodo esté en la página y no surte efecto). Así la marca de agua entra con él.
//
// Donde el navegador no lleva a pantalla completa más que el video (iPhone), Mux caería a la
// del sistema, que no pinta la marca. Ahí la pantalla completa es dentro de la página: el
// contenedor se fija sobre toda la ventana, con «Salir de pantalla completa» y, en vertical, el
// aviso de girar el teléfono y «Girar», que rota el contenedor. Se atrapan los pedidos de Mux
// (su botón, la tecla F) antes de que lleguen a su controlador, y si iOS entra solo a la del
// sistema (con un pellizco), se sale y se pasa a la propia (diseño, sección 5.4; D-08).
//
// Los subtítulos arrancan como la cuenta los dejó (RF-310), y cuando la persona los enciende o
// los apaga, se avisa a la pantalla para que lo recuerde.
//
// Para los tramos vistos (T-205) avisa cada muestra mientras el video avanza, y cuándo se detiene
// el tramo (`onWatch`). Lo decide con el elemento en el evento mismo (`paused`), no con lo que la
// pantalla sabe de antes: una muestra que llega con el video ya en pausa detiene, no extiende.
//
// Cuando la dirección caduca, la pantalla pide otra y la pasa con otra concesión (`grant`): solo
// el Mux Player se monta de nuevo, dentro del mismo contenedor, así que no se sale de la pantalla
// completa (la del navegador ni la propia) y la marca sigue donde estaba. Cambiar solo los tokens
// del mismo Mux Player no basta: no vuelve a cargar el video. El elemento nuevo se liga al
// contenedor, recibe el foco si lo tenía el viejo, y al cargar repone la velocidad, el volumen y
// el silencio, y sigue si la persona le había dado reproducir (Safari puede negarse sin un toque:
// entonces queda en pausa en el segundo en que iba).
//
// Lo que se le apaga, a propósito:
//   · Mux Data (`disableTracking`, `disableCookies`, sin `envKey`): ni analítica ni cookies.
//   · Enviar a otra pantalla, AirPlay e imagen dentro de imagen (diseño, sección 5.4 y D-08).
//     No tienen prop: se apagan en el `<video>` interno (`lockDown`). Sin eso, Mux Player pide
//     un script de Google para enviar a un televisor.
//   · Recordar el volumen y el silencio en el navegador.
//   · El selector de calidad: es automática (RF-312). Lo esconde `player-mux`, de `theme.css`.
//   · Los subtítulos encendidos de fábrica: arrancan apagados, salvo que la cuenta los haya
//     dejado encendidos (diseño, sección 5.4).
//
// Sus errores no salen de aquí: algunos mensajes de Mux traen el playback id, y nada de eso
// va al registro de errores. La pantalla solo sabe si caducó la dirección o si falló.

addTranslation("es-MX", { ...Es, ...controlLabels() });
setLanguage("es-MX");

/** Los controles se ocultan a los tres segundos sin moverse (diseño, sección 5.4); Mux trae dos. */
const AUTOHIDE_SECONDS = 3;

/** Cuánto dura a la vista el aviso de girar el teléfono, al entrar a la pantalla completa propia. */
export const TURN_HINT_MS = 4_000;

/** Los pedidos de pantalla completa de los controles de Mux (media-chrome), y los de subtítulos. */
const ENTER_FULLSCREEN = "mediaenterfullscreenrequest";
const EXIT_FULLSCREEN = "mediaexitfullscreenrequest";
const CAPTIONS_REQUESTS = ["mediashowsubtitlesrequest", "mediadisablesubtitlesrequest", "mediatogglesubtitlesrequest"];
/** Los pedidos de reproducir y de pausar de los controles de Mux (su botón, un toque, la barra espaciadora). */
const PLAY_REQUEST = "mediaplayrequest";
const PAUSE_REQUEST = "mediapauserequest";

/** Si el foco quedó sin dueño: el elemento que lo tenía se fue de la página. */
function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Si el navegador lleva a pantalla completa un elemento cualquiera, y no solo el video. En
 * iPhone no: ahí va la pantalla completa propia.
 */
function elementFullscreenAvailable(): boolean {
  const doc = document as Document & { webkitFullscreenEnabled?: boolean };
  return doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true;
}

/** Si el aparato está en vertical: ahí van el aviso y «Girar». */
const PORTRAIT = "(orientation: portrait)";
function subscribePortrait(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(PORTRAIT);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const portraitNow = () => typeof window.matchMedia === "function" && window.matchMedia(PORTRAIT).matches;
const portraitOnServer = () => false;

/** Si hay subtítulos a la vista en el video. */
function captionsShowing(video: HTMLVideoElement | undefined): boolean {
  const tracks = video?.textTracks;
  if (!tracks) return false;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track && (track.kind === "subtitles" || track.kind === "captions") && track.mode === "showing") return true;
  }
  return false;
}

export interface PlayerProps {
  /**
   * Qué concesión de la pantalla es: con otra (una dirección renovada) se monta otro Mux Player.
   * No es el token: firmado con la hora en segundos y sin azar, dos pedidos seguidos dan el mismo.
   */
  grant: number;
  playbackId: string;
  tokens: { playback: string; thumbnail: string; storyboard: string };
  /** Desde qué segundo: el mismo en que iba, si la dirección se renovó. */
  startTime: number;
  /** El menú de velocidades, el que dio la función única de medios. */
  speeds: number[];
  /** El correo para la marca de agua. Sin él no se pinta ninguna (revisión, hasta T-405). */
  watermark?: string | null;
  /** Si arranca con los subtítulos encendidos: como los dejó la cuenta (RF-310). Por omisión, apagados. */
  captions?: boolean;
  /** La persona encendió o apagó los subtítulos. */
  onCaptionsChange?: (on: boolean) => void;
  /** Mux dijo que la dirección caducó; `at` es el segundo en que iba. */
  onExpired: (at: number) => void;
  /** Cualquier otro error. */
  onFailed: () => void;
  /** Empezó a reproducirse: lo que se renovó ya sirvió. */
  onPlaying: () => void;
  /** Llegó al final (la lección: «Lección terminada» y la siguiente). */
  onEnded?: () => void;
  /**
   * El video empezó a avanzar (`true`) o se detuvo: una pausa, el final, un error. Mientras
   * avanza, la lección late su reproducción (T-204, RF-107). Esperar a que cargue no lo detiene.
   */
  onAdvancing?: (advancing: boolean) => void;
  /** El segundo en que va, cada vez que avanza: para volver a él si la reproducción se cierra (T-204). */
  onProgress?: (at: number) => void;
  /** Cada muestra mientras avanza, y cuándo se detiene el tramo (T-205). La revisión no lo usa. */
  onWatch?: (signal: WatchSignal) => void;
  /** Una nota de la pantalla (PA-22, «Sin conexión»), que se pinta dentro en la pantalla completa propia. */
  notice?: string | null;
}

/** Lo que trae un error de Mux (su `MediaError`): si es fatal, y su código. Sus tipos no lo declaran. */
interface MuxError {
  fatal?: boolean;
  muxCode?: number;
}

/** Lo que el elemento de Mux tiene dentro y no declara en sus tipos: el `<video>` de verdad y su controlador. */
interface WithNativeVideo {
  nativeEl?: HTMLVideoElement & { webkitExitFullscreen?: () => void };
  setAttribute?: (name: string, value: string) => void;
}
interface WithController {
  mediaController?: {
    fullscreenElement?: HTMLElement | null;
    setAttribute?: (name: string, value: string) => void;
    focus?: (options?: FocusOptions) => void;
  } | null;
}

/**
 * Le da el foco al reproductor. Se lo lleva su controlador: el elemento de Mux no lo recibe (su
 * sombra no lo delega y no tiene `tabindex`), y los atajos del teclado escuchan en el controlador.
 */
function focusPlayer(element: MuxPlayerRefAttributes | null) {
  const controller = (element as unknown as WithController | null)?.mediaController;
  if (controller?.focus) controller.focus({ preventScroll: true });
  else (element as unknown as HTMLElement | null)?.focus?.({ preventScroll: true });
}

/** Lo que se repone en el Mux Player nuevo cuando la dirección caducó. */
interface Resume {
  playbackRate: number;
  volume: number;
  muted: boolean;
  /** El foco estaba dentro del reproductor. */
  focused: boolean;
}

/**
 * Apaga enviar a otra pantalla e imagen dentro de imagen en el `<video>` interno. Corre al
 * conectarse el elemento, antes de que Mux Player reciba el playback id (eso lo hace en un
 * efecto, que corre después): el script de Google se pide al leer `remote` sin esto puesto.
 */
function lockDown(element: MuxPlayerRefAttributes | null) {
  if (element === null) return;
  const media = element.media as unknown as WithNativeVideo | null | undefined;
  media?.setAttribute?.("disableremoteplayback", "");
  media?.setAttribute?.("disablepictureinpicture", "");
  if (media?.nativeEl) {
    media.nativeEl.disableRemotePlayback = true;
    media.nativeEl.disablePictureInPicture = true;
  }
}

/**
 * Lo que el reproductor dice para los tramos vistos (T-205): una muestra mientras el video avanza,
 * o que el tramo se detiene (pausa, final, búsqueda, un atasco, un error).
 */
export type WatchSignal = { kind: "tick"; at: number; rate: number; duration: number } | { kind: "stop" };

/** Lo que un evento del elemento dice para los tramos: una muestra si avanza, o que se detiene. */
function watchSignal(target: EventTarget | null): WatchSignal {
  const media = target as Partial<Pick<HTMLMediaElement, "currentTime" | "playbackRate" | "duration" | "paused">> | null;
  if (media?.paused !== false || typeof media.currentTime !== "number" || typeof media.playbackRate !== "number") return { kind: "stop" };
  return { kind: "tick", at: media.currentTime, rate: media.playbackRate, duration: typeof media.duration === "number" ? media.duration : Number.NaN };
}

/** El `<video>` de verdad, dentro de Mux Player. */
function nativeVideo(element: MuxPlayerRefAttributes | null) {
  return (element?.media as unknown as WithNativeVideo | null | undefined)?.nativeEl;
}

export function Player(props: PlayerProps) {
  const {
    grant,
    playbackId,
    tokens,
    startTime,
    speeds,
    watermark,
    captions = false,
    onCaptionsChange,
    onExpired,
    onFailed,
    onPlaying,
    onEnded,
    onAdvancing,
    onProgress,
    onWatch,
    notice,
  } = props;
  const stopWatch = () => onWatch?.({ kind: "stop" });
  const frame = useRef<HTMLDivElement>(null);
  const mux = useRef<MuxPlayerRefAttributes | null>(null);
  // El último Mux Player que se ligó: React suelta y vuelve a poner la referencia en cada render.
  const bound = useRef<MuxPlayerRefAttributes | null>(null);
  // Si la persona le dio reproducir y no pausó desde entonces; y lo que se repone si la dirección
  // caducó, con el Mux Player al que caducó (a ese no se le repone nada).
  const wantsPlay = useRef(false);
  const resume = useRef<(Resume & { from: MuxPlayerRefAttributes | null }) | null>(null);
  const mark = useRef<HTMLParagraphElement>(null);
  const fading = useRef(false);
  const exitButton = useRef<HTMLButtonElement>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const filledNow = useRef(false);
  const captionsNow = useRef(captions);
  const captionsChanged = useRef(onCaptionsChange);
  useEffect(() => {
    captionsChanged.current = onCaptionsChange;
  });

  // La pantalla completa propia: si está puesta, si se giró, y el aviso de girar.
  const [filled, setFilled] = useState(false);
  const [turned, setTurned] = useState(false);
  const [hint, setHint] = useState(false);
  const portrait = useSyncExternalStore(subscribePortrait, portraitNow, portraitOnServer);
  const rotated = filled && turned && portrait;

  /**
   * Entra o sale de la pantalla completa propia. El aviso de girar se pinta solo dentro, y dura
   * un momento contado desde la última vez que se entró.
   */
  const fill = useCallback((on: boolean) => {
    filledNow.current = on;
    setFilled(on);
    setTurned(false);
    setHint(true);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(false), TURN_HINT_MS);
  }, []);

  /** El contenedor entra a pantalla completa, y los controles se ocultan a su tiempo. */
  const bindController = useCallback(() => {
    const controller = (mux.current as unknown as WithController | null)?.mediaController;
    if (!controller || frame.current === null) return;
    if (controller.fullscreenElement !== frame.current) controller.fullscreenElement = frame.current;
    controller.setAttribute?.("autohide", String(AUTOHIDE_SECONDS));
  }, []);

  // Una función nueva en cada render: React suelta y vuelve a poner la referencia, y `lockDown`
  // corre otra vez, sin efecto. Con `useCallback` el compilador de React ya no deja tocar el
  // controlador de Mux en `bindController`. Un Mux Player nuevo (otra concesión) se liga al
  // contenedor en el acto, antes de cargar, y si el foco estaba en el viejo, pasa a él: los
  // atajos del teclado escuchan en su controlador, y en el documento no sirven.
  function attach(element: MuxPlayerRefAttributes | null) {
    lockDown(element);
    mux.current = element;
    if (element === null || element === bound.current) return;
    bound.current = element;
    bindController();
    if (resume.current?.focused && focusIsLost()) focusPlayer(element);
  }

  /**
   * Al cargar: el controlador, y en un Mux Player nuevo tras una caducidad, lo que la persona
   * tenía. Si sigue o no se decide ahora, no al caducar: pudo pausar mientras llegaba la dirección.
   */
  function loaded() {
    bindController();
    const element = mux.current as (MuxPlayerRefAttributes & Partial<Pick<HTMLMediaElement, "playbackRate" | "volume" | "muted" | "play">>) | null;
    const kept = resume.current;
    if (element === null || kept === null || kept.from === element) return;
    resume.current = null;
    element.playbackRate = kept.playbackRate;
    element.volume = kept.volume;
    element.muted = kept.muted;
    if (wantsPlay.current) element.play?.()?.catch(() => undefined);
  }

  /** Sin la marca en su lugar, el video no sigue (TRD §9.4). */
  const guard = useCallback(() => {
    if (watermark && !watermarkIntact(mark.current, frame.current, watermark, fading.current)) mux.current?.pause();
  }, [watermark]);

  useEffect(bindController, [bindController]);

  // Los pedidos de pantalla completa de Mux (su botón, la tecla F) se atrapan en la captura, antes
  // de que lleguen a su controlador, solo donde la del navegador no llevaría el contenedor. Pedir
  // entrar estando dentro (la tecla F) sale.
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const intercept = (event: Event) => {
      if (elementFullscreenAvailable()) return;
      event.stopPropagation();
      fill(event.type === ENTER_FULLSCREEN && !filledNow.current);
    };
    element.addEventListener(ENTER_FULLSCREEN, intercept, true);
    element.addEventListener(EXIT_FULLSCREEN, intercept, true);
    return () => {
      element.removeEventListener(ENTER_FULLSCREEN, intercept, true);
      element.removeEventListener(EXIT_FULLSCREEN, intercept, true);
    };
  }, [fill]);

  // Si iOS entra solo a la pantalla completa del sistema (un pellizco sobre el video), se sale de
  // ella y se pasa a la propia: la del sistema no pinta la marca. Si ya estaba en la propia, se
  // queda como estaba, girada o no. Se escucha en el video de cada Mux Player: con otra concesión
  // el video es otro.
  useEffect(() => {
    const video = nativeVideo(mux.current);
    if (typeof video?.addEventListener !== "function") return;
    const takeBack = () => {
      video.webkitExitFullscreen?.();
      if (!filledNow.current) fill(true);
    };
    video.addEventListener("webkitbeginfullscreen", takeBack);
    return () => video.removeEventListener("webkitbeginfullscreen", takeBack);
  }, [fill, grant]);

  // Dentro de la propia: la página de atrás no se desplaza, Escape sale (con un teclado), y el
  // foco va a «Salir de pantalla completa». Al salir, si el foco quedó sin dueño, vuelve al video.
  useEffect(() => {
    if (!filled) return;
    const root = document.documentElement;
    root.classList.add("player-locked");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") fill(false);
    };
    document.addEventListener("keydown", onKey);
    exitButton.current?.focus();
    return () => {
      root.classList.remove("player-locked");
      document.removeEventListener("keydown", onKey);
      if (focusIsLost()) focusPlayer(mux.current);
    };
  }, [filled, fill]);

  useEffect(() => () => clearTimeout(hintTimer.current), []);

  // Los subtítulos: cuando la persona los enciende o los apaga (el menú de Mux, la tecla C), su
  // controlador ya cambió las pistas al llegar el pedido aquí, de subida. Se avisa solo si cambió.
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const noticed = () => {
      const on = captionsShowing(nativeVideo(mux.current));
      if (on === captionsNow.current) return;
      captionsNow.current = on;
      captionsChanged.current?.(on);
    };
    for (const request of CAPTIONS_REQUESTS) element.addEventListener(request, noticed);
    return () => {
      for (const request of CAPTIONS_REQUESTS) element.removeEventListener(request, noticed);
    };
  }, []);

  // Si la persona le dio reproducir (los controles de Mux piden de subida, por el contenedor), para
  // seguir si la dirección caduca justo entonces. Las pausas que no pasan por sus controles las
  // cuenta `onPause`.
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const play = () => void (wantsPlay.current = true);
    const pause = () => void (wantsPlay.current = false);
    element.addEventListener(PLAY_REQUEST, play);
    element.addEventListener(PAUSE_REQUEST, pause);
    return () => {
      element.removeEventListener(PLAY_REQUEST, play);
      element.removeEventListener(PAUSE_REQUEST, pause);
    };
  }, []);

  // Cualquier cambio dentro del contenedor (quitarla, ocultarla, cambiarle el texto) se revisa.
  useEffect(() => {
    if (!watermark || frame.current === null) return;
    const observer = new MutationObserver(guard);
    observer.observe(frame.current, { subtree: true, childList: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }, [watermark, guard]);

  return (
    <div
      ref={frame}
      data-player-frame
      data-filled={filled ? "" : undefined}
      data-turned={rotated ? "" : undefined}
      className={cx("player-frame overflow-hidden", filled ? "player-frame-filled" : "relative aspect-video w-full")}
    >
      <div className="player-stage">
        <MuxPlayer
          key={grant}
          ref={attach}
          className="player-mux block h-full w-full"
          playbackId={playbackId}
          tokens={tokens}
          startTime={startTime}
          playbackRates={speeds}
          forwardSeekOffset={SEEK_SECONDS}
          backwardSeekOffset={SEEK_SECONDS}
          defaultHiddenCaptions={!captions}
          disableTracking
          disableCookies
          noVolumePref
          noMutedPref
          onLoadedMetadata={loaded}
          onPlay={() => {
            wantsPlay.current = true;
            guard();
          }}
          onPlaying={() => {
            onAdvancing?.(true);
            onPlaying();
          }}
          onTimeUpdate={(event) => {
            onProgress?.((event.target as { currentTime?: number } | null)?.currentTime ?? 0);
            onWatch?.(watchSignal(event.target));
          }}
          onRateChange={(event) => onWatch?.(watchSignal(event.target))}
          onSeeking={stopWatch}
          onWaiting={stopWatch}
          onEmptied={stopWatch}
          onPause={(event) => {
            stopWatch();
            onAdvancing?.(false);
            // Una pausa que no viene de sus controles (la pantalla de bloqueo, unos audífonos que se
            // desconectan) también cuenta; la que acompaña a un error, no.
            if (!(event.target as { error?: unknown } | null)?.error) wantsPlay.current = false;
          }}
          onEnded={() => {
            stopWatch();
            wantsPlay.current = false;
            onAdvancing?.(false);
            onEnded?.();
          }}
          onError={(event) => {
            const player = event.target as (MuxPlayerRefAttributes & { error?: MuxError | null } & Partial<HTMLMediaElement>) | null;
            const error = (event as Event & { detail?: MuxError | null }).detail ?? player?.error ?? null;
            // Lo que Mux no da por fatal (reconectando, sin red un momento) lo resuelve él solo.
            if (error?.fatal === false) return;
            stopWatch();
            if (error?.muxCode === TOKEN_EXPIRED) {
              resume.current = {
                from: player,
                playbackRate: player?.playbackRate ?? 1,
                volume: player?.volume ?? 1,
                muted: player?.muted ?? false,
                focused: frame.current?.contains(document.activeElement) ?? false,
              };
              onExpired(player?.currentTime ?? 0);
            } else onFailed();
          }}
        />
        {watermark ? <Watermark text={watermark} elementRef={mark} fadingRef={fading} onMoved={guard} /> : null}
      </div>
      {filled ? (
        <div className="player-filled-bar pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2">
          <button
            ref={exitButton}
            type="button"
            onClick={() => fill(false)}
            className="pointer-events-auto min-h-touch rounded-md bg-scrim px-4 text-body font-semibold text-text"
          >
            {text.controls.exitFullscreen}
          </button>
          {notice ? <p className="rounded-md bg-scrim px-3 py-2 text-body-s text-text">{notice}</p> : null}
          {portrait ? (
            <button
              type="button"
              aria-pressed={turned}
              onClick={() => setTurned((current) => !current)}
              className="pointer-events-auto min-h-touch rounded-md bg-scrim px-4 text-body font-semibold text-text"
            >
              {text.filled.turn}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Existe desde antes de entrar: una región viva que nace con su texto no se anuncia. */}
      <p role="status" className="player-filled-hint pointer-events-none absolute inset-x-0 bottom-0 m-0 text-center text-body text-text">
        {filled && hint && portrait && !turned ? text.filled.turnHint : ""}
      </p>
    </div>
  );
}
