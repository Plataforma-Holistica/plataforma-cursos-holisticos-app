"use client";

// El español de los controles: media-chrome, sobre el que está hecho Mux Player, solo trae el
// inglés registrado. Se registra su español con los nombres del diseño encima, como `es-MX`
// (registrar un idioma reemplaza su diccionario entero, no lo mezcla), y el idioma queda fijo.
import { Es } from "media-chrome/dist/lang/es.js";
import { addTranslation, setLanguage } from "media-chrome/dist/utils/i18n.js";
import MuxPlayer, { type MuxPlayerRefAttributes } from "@mux/mux-player-react";
import { useCallback, useEffect, useRef } from "react";

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
// Lo que se le apaga, a propósito:
//   · Mux Data (`disableTracking`, `disableCookies`, sin `envKey`): ni analítica ni cookies.
//   · Enviar a otra pantalla, AirPlay e imagen dentro de imagen (diseño, sección 5.4 y D-08).
//     No tienen prop: se apagan en el `<video>` interno (`lockDown`). Sin eso, Mux Player pide
//     un script de Google para enviar a un televisor.
//   · Recordar el volumen y el silencio en el navegador.
//   · El selector de calidad: es automática (RF-312). Lo esconde `player-mux`, de `theme.css`.
//   · Los subtítulos encendidos de fábrica: arrancan apagados (diseño, sección 5.4).
//
// Sus errores no salen de aquí: algunos mensajes de Mux traen el playback id, y nada de eso
// va al registro de errores. La pantalla solo sabe si caducó la dirección o si falló.

addTranslation("es-MX", { ...Es, ...controlLabels() });
setLanguage("es-MX");

/** Los controles se ocultan a los tres segundos sin moverse (diseño, sección 5.4); Mux trae dos. */
const AUTOHIDE_SECONDS = 3;

export interface PlayerProps {
  playbackId: string;
  tokens: { playback: string; thumbnail: string; storyboard: string };
  /** Desde qué segundo: el mismo en que iba, si la dirección se renovó. */
  startTime: number;
  /** El menú de velocidades, el que dio la función única de medios. */
  speeds: number[];
  /** El correo para la marca de agua. Sin él no se pinta ninguna (revisión, hasta T-405). */
  watermark?: string | null;
  /** Mux dijo que la dirección caducó; `at` es el segundo en que iba. */
  onExpired: (at: number) => void;
  /** Cualquier otro error. */
  onFailed: () => void;
  /** Empezó a reproducirse: lo que se renovó ya sirvió. */
  onPlaying: () => void;
}

/** Lo que trae un error de Mux (su `MediaError`): si es fatal, y su código. Sus tipos no lo declaran. */
interface MuxError {
  fatal?: boolean;
  muxCode?: number;
}

/** Lo que el elemento de Mux tiene dentro y no declara en sus tipos: el `<video>` de verdad y su controlador. */
interface WithNativeVideo {
  nativeEl?: HTMLVideoElement;
  setAttribute?: (name: string, value: string) => void;
}
interface WithController {
  mediaController?: { fullscreenElement?: HTMLElement | null; setAttribute?: (name: string, value: string) => void } | null;
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

export function Player({ playbackId, tokens, startTime, speeds, watermark, onExpired, onFailed, onPlaying }: PlayerProps) {
  const frame = useRef<HTMLDivElement>(null);
  const mux = useRef<MuxPlayerRefAttributes | null>(null);
  const mark = useRef<HTMLParagraphElement>(null);
  const fading = useRef(false);

  function attach(element: MuxPlayerRefAttributes | null) {
    lockDown(element);
    mux.current = element;
  }

  /** El contenedor entra a pantalla completa, y los controles se ocultan a su tiempo. */
  const bindController = useCallback(() => {
    const controller = (mux.current as unknown as WithController | null)?.mediaController;
    if (!controller || frame.current === null) return;
    if (controller.fullscreenElement !== frame.current) controller.fullscreenElement = frame.current;
    controller.setAttribute?.("autohide", String(AUTOHIDE_SECONDS));
  }, []);

  /** Sin la marca en su lugar, el video no sigue (TRD §9.4). */
  const guard = useCallback(() => {
    if (watermark && !watermarkIntact(mark.current, frame.current, watermark, fading.current)) mux.current?.pause();
  }, [watermark]);

  useEffect(bindController, [bindController]);

  // Cualquier cambio dentro del contenedor (quitarla, ocultarla, cambiarle el texto) se revisa.
  useEffect(() => {
    if (!watermark || frame.current === null) return;
    const observer = new MutationObserver(guard);
    observer.observe(frame.current, { subtree: true, childList: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }, [watermark, guard]);

  return (
    <div ref={frame} data-player-frame className="player-frame relative aspect-video w-full overflow-hidden">
      <MuxPlayer
        ref={attach}
        className="player-mux block h-full w-full"
        playbackId={playbackId}
        tokens={tokens}
        startTime={startTime}
        playbackRates={speeds}
        forwardSeekOffset={SEEK_SECONDS}
        backwardSeekOffset={SEEK_SECONDS}
        defaultHiddenCaptions
        disableTracking
        disableCookies
        noVolumePref
        noMutedPref
        onLoadedMetadata={bindController}
        onPlay={guard}
        onPlaying={onPlaying}
        onError={(event) => {
          const player = event.target as (MuxPlayerRefAttributes & { error?: MuxError | null }) | null;
          const error = (event as Event & { detail?: MuxError | null }).detail ?? player?.error ?? null;
          // Lo que Mux no da por fatal (reconectando, sin red un momento) lo resuelve él solo.
          if (error?.fatal === false) return;
          if (error?.muxCode === TOKEN_EXPIRED) onExpired(player?.currentTime ?? 0);
          else onFailed();
        }}
      />
      {watermark ? <Watermark text={watermark} elementRef={mark} fadingRef={fading} onMoved={guard} /> : null}
    </div>
  );
}
