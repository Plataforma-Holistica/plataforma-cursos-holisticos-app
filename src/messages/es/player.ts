import { defineMessages } from "../format";

// Los textos del reproductor de video (diseño, sección 5.4). Es el bloque que importa el
// reproductor compartido, que corre en el navegador: así el catálogo entero no viaja con él.
//
// Los controles los pinta Mux Player (media-chrome por dentro), y estos textos reemplazan sus
// nombres de fábrica (`src/app/_video/labels.ts` dice qué clave de media-chrome lleva cada
// uno). Los marcadores de `time` y `rateNamed` los sustituye media-chrome con su propio valor.
export const player = defineMessages({
  controls: {
    play: "Reproducir",
    pause: "Pausar",
    seekBack: "Regresar {seconds} segundos",
    seekForward: "Adelantar {seconds} segundos",
    mute: "Silenciar",
    unmute: "Activar sonido",
    volume: "Volumen",
    seek: "Avance",
    time: "{currentTime} de {totalTime}",
    captions: "Subtítulos",
    captionsOn: "Activar subtítulos",
    captionsOff: "Desactivar subtítulos",
    rate: "Velocidad",
    rateNamed: "Velocidad, {playbackRate}",
    rateCurrent: "Velocidad actual",
    fullscreen: "Pantalla completa",
    exitFullscreen: "Salir de pantalla completa",
  },
});
