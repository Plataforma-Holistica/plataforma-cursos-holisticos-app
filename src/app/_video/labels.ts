import { t } from "@/messages/format";
import { player } from "@/messages/es/player";

// Los nombres de los controles del reproductor (diseño, sección 5.4, tabla de controles), con
// las claves de media-chrome, el motor de controles de Mux Player. Las que dan el nombre
// accesible van en minúsculas y las que dan la etiqueta a la vista, con mayúscula: se ponen
// las dos. Lo que el diseño no nombra queda en el español de fábrica de media-chrome.

/** Cuánto saltan «Regresar» y «Adelantar» (RF-312). Es del diseño, no del negocio. */
export const SEEK_SECONDS = 10;

/** El diccionario que se registra sobre el español de media-chrome. */
export function controlLabels(): Record<string, string> {
  const c = player.controls;
  const seekBack = t(c.seekBack, { seconds: SEEK_SECONDS });
  const seekForward = t(c.seekForward, { seconds: SEEK_SECONDS });
  // media-chrome sustituye estos marcadores con su propio valor: se dejan como los espera.
  const time = t(c.time, { currentTime: "{currentTime}", totalTime: "{totalTime}" });
  const rateNamed = t(c.rateNamed, { playbackRate: "{playbackRate}" });
  return {
    Play: c.play,
    play: c.play,
    Pause: c.pause,
    pause: c.pause,
    "Seek backward": seekBack,
    "seek back {seekOffset} seconds": seekBack,
    "Seek forward": seekForward,
    "seek forward {seekOffset} seconds": seekForward,
    Mute: c.mute,
    mute: c.mute,
    Unmute: c.unmute,
    unmute: c.unmute,
    volume: c.volume,
    seek: c.seek,
    "{currentTime} of {totalTime}": time,
    Captions: c.captions,
    "closed captions": c.captions,
    "Enable captions": c.captionsOn,
    "Disable captions": c.captionsOff,
    "Playback rate": c.rate,
    "Playback rate {playbackRate}": rateNamed,
    "current playback rate": c.rateCurrent,
    "Enter fullscreen mode": c.fullscreen,
    "enter fullscreen mode": c.fullscreen,
    "Exit fullscreen mode": c.exitFullscreen,
    "exit fullscreen mode": c.exitFullscreen,
  };
}
