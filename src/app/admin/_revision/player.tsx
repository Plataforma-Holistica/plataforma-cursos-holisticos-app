"use client";

// El español de los controles: media-chrome, sobre el que está hecho Mux Player, solo trae el
// inglés registrado. Este módulo lo registra al cargarse, y deja el idioma fijo.
import "media-chrome/dist/lang/es.js";
import { setLanguage } from "media-chrome/dist/utils/i18n.js";
import MuxPlayer, { type MuxPlayerRefAttributes } from "@mux/mux-player-react";

import { TOKEN_EXPIRED } from "./outcomes";

// El reproductor de la pantalla de revisión (diseño, sección 5, variante de revisión; T-108;
// decisión de Sergio del 2026-10-14). Es el único archivo que importa Mux Player, y solo lo
// carga la pantalla con `next/dynamic`, cuando alguien pulsa «Ver»: así no viaja con la
// página. Una prueba de arquitectura y el lint lo exigen.
//
// Lo que se le apaga, a propósito:
//   · Mux Data (`disableTracking`, `disableCookies`, sin `envKey`): ni analítica ni cookies.
//   · Enviar a otra pantalla, AirPlay e imagen dentro de imagen (diseño, sección 5.4 y D-08).
//     No tienen prop: se apagan en el `<video>` interno (`lockDown`). Sin eso, Mux Player pide
//     un script de Google para enviar a un televisor.
//   · Recordar el volumen y el silencio en el navegador.
//
// Sus errores no salen de aquí: algunos mensajes de Mux traen el playback id, y nada de eso
// va al registro de errores. La pantalla solo sabe si caducó la dirección o si falló.

setLanguage("es");

export interface PlayerProps {
  playbackId: string;
  tokens: { playback: string; thumbnail: string; storyboard: string };
  /** Desde qué segundo: el mismo en que iba, si la dirección se renovó. */
  startTime: number;
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

/** Lo que el elemento de Mux tiene dentro y no declara en sus tipos: el `<video>` de verdad. */
interface WithNativeVideo {
  nativeEl?: HTMLVideoElement;
  setAttribute?: (name: string, value: string) => void;
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

export function Player({ playbackId, tokens, startTime, onExpired, onFailed, onPlaying }: PlayerProps) {
  return (
    <MuxPlayer
      ref={lockDown}
      className="block aspect-video w-full"
      playbackId={playbackId}
      tokens={tokens}
      startTime={startTime}
      disableTracking
      disableCookies
      noVolumePref
      noMutedPref
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
  );
}
